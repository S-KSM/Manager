import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';

export type InterventionKind =
  | 'nudge'
  | 'redirect'
  | 'rollback'
  | 'approval_required'
  | 'question_required';

/**
 * Wire-format Intervention as documented in docs/ARCHITECTURE.md
 * (snake_case JSON over the HTTP API). The DB stores `payload_json`
 * as TEXT and the class parses on read / stringifies on write.
 */
export interface Intervention {
  id: string;
  workstream_id: string;
  kind: InterventionKind;
  payload: InterventionPayload;
  created_at: string;
  delivered_at: string | null;
}

export interface InterventionPayload {
  message?: string;
  rollback_to_decision_id?: string;
  /**
   * v1.4.4 (`approval_required` only) — what the agent is asking permission to
   * do. Free-form for now; future schema lands when the MCP tool that emits
   * these is built.
   */
  approval_request?: {
    summary?: string;
    tool?: string;
    detail?: string;
  };
  /**
   * v1.4.4 (`approval_required` only) — set by the manager via the ACK call:
   * `{ approved: true }` lets the run proceed; `{ approved: false }` is the
   * Deny path. Round-trip: agent enqueues with `approval_request`, manager
   * acks with the decision attached.
   */
  approval_decision?: { approved: boolean };
  /**
   * v1.4.7 (`question_required` only) — agent asks the manager a question and
   * blocks on `mcp__dispatch__ask_user` until the manager picks an option (or
   * supplies free text) in the Dispatch app. The MCP tool enqueues with
   * `question_request` and the manager answers via
   * `POST /workstreams/:id/interventions/:intId/answer`.
   */
  question_request?: {
    question: string;
    options?: string[];
    allow_freetext?: boolean;
    /** Optional context line shown above the question — e.g. tool name. */
    context?: string;
  };
  /**
   * v1.4.7 (`question_required` only) — set by the manager via `/answer`.
   * `choice` matches one of `question_request.options` when the manager
   * picked one; `freetext` is set when the manager typed a custom answer
   * (allowed only if `allow_freetext === true`). At least one of the two is
   * always present on a delivered question.
   */
  question_answer?: {
    choice?: string;
    freetext?: string;
  };
}

interface InterventionRow {
  id: string;
  workstream_id: string;
  kind: InterventionKind;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
}

/**
 * SQLite-backed FIFO queue of pending interventions per workstream.
 *
 * Lives in the same `~/.claude/dispatch/db.sqlite` as `WorkstreamRegistry`.
 * The class opens its own connection (with the same WAL + foreign_keys
 * pragmas) rather than sharing the registry's: keeps construction
 * symmetrical with `WorkstreamRegistry`, makes test setup trivial, and
 * SQLite's WAL mode handles concurrent writers from a single process
 * safely.
 *
 * Mirrors `WorkstreamRegistry`'s shape — optional `dbPath`, lazy
 * `migrate()` in constructor, prepared statements where helpful.
 */
export class InterventionQueue {
  private readonly db: DatabaseType;

  constructor(dbPath?: string) {
    const path = dbPath ?? getConfig().dbPath;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interventions (
        id            TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL,
        kind          TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        delivered_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_interventions_pending
        ON interventions(workstream_id, delivered_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a new intervention; returns the persisted wire-format object. */
  enqueue(
    workstreamId: string,
    kind: InterventionKind,
    payload: InterventionPayload,
  ): Intervention {
    const id = `int_${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const payloadJson = JSON.stringify(payload ?? {});
    this.db
      .prepare(
        'INSERT INTO interventions (id, workstream_id, kind, payload_json, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, NULL)',
      )
      .run(id, workstreamId, kind, payloadJson, createdAt);
    return {
      id,
      workstream_id: workstreamId,
      kind,
      payload: this.parsePayload(payloadJson),
      created_at: createdAt,
      delivered_at: null,
    };
  }

  /** Pending (not yet delivered) interventions for a workstream, oldest first. */
  listPending(workstreamId: string): Intervention[] {
    const rows = this.db
      .prepare(
        'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE workstream_id = ? AND delivered_at IS NULL ORDER BY created_at ASC, id ASC',
      )
      .all(workstreamId) as InterventionRow[];
    return rows.map((r) => this.rowToWire(r));
  }

  /**
   * Mark each given id as delivered (now). Idempotent: missing or
   * already-delivered ids are silently skipped. Runs in a single
   * transaction. Returns the rows that were actually updated by *this*
   * call (so callers can use the result for event-emission /
   * audit-trail purposes).
   */
  ackDelivered(ids: string[]): Intervention[] {
    if (!ids.length) return [];
    const now = new Date().toISOString();
    const updateStmt = this.db.prepare(
      'UPDATE interventions SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    );
    const selectStmt = this.db.prepare(
      'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE id = ?',
    );
    const updated: Intervention[] = [];
    const txn = this.db.transaction((batch: string[]) => {
      for (const id of batch) {
        const result = updateStmt.run(now, id);
        if (result.changes > 0) {
          const row = selectStmt.get(id) as InterventionRow | undefined;
          if (row) updated.push(this.rowToWire(row));
        }
      }
    });
    txn(ids);
    return updated;
  }

  /**
   * v1.4.4 — record an approval decision and mark the intervention delivered
   * in one shot. The decision is merged into `payload.approval_decision`
   * (preserving any existing `approval_request`). Returns the updated row, or
   * null if the intervention id is unknown / already delivered.
   */
  decideApproval(id: string, approved: boolean): Intervention | null {
    const selectStmt = this.db.prepare(
      'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE id = ?',
    );
    const row = selectStmt.get(id) as InterventionRow | undefined;
    if (!row) return null;
    if (row.delivered_at !== null) return null;
    if (row.kind !== 'approval_required') return null;
    const payload = this.parsePayload(row.payload_json);
    payload.approval_decision = { approved };
    const nowTs = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE interventions SET payload_json = ?, delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
      )
      .run(JSON.stringify(payload), nowTs, id);
    const updated = selectStmt.get(id) as InterventionRow;
    return this.rowToWire(updated);
  }

  /**
   * v1.4.7 — fetch one intervention by id (any state), or `null` if missing.
   * Used by the MCP `ask_user` polling loop so the agent can wait for the
   * manager's `/answer` round-trip without hammering listPending.
   */
  get(id: string): Intervention | null {
    const row = this.db
      .prepare(
        'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE id = ?',
      )
      .get(id) as InterventionRow | undefined;
    return row ? this.rowToWire(row) : null;
  }

  /**
   * v1.4.7 — record a question answer and mark the intervention delivered in
   * one shot. Mirrors `decideApproval`. Returns null if the intervention id
   * is unknown, already delivered, or not a `question_required`. The caller
   * is responsible for validating that `answer.choice` matches a known option
   * (or that `allow_freetext` was set when only freetext is supplied).
   */
  answerQuestion(
    id: string,
    answer: { choice?: string; freetext?: string },
  ): Intervention | null {
    const selectStmt = this.db.prepare(
      'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE id = ?',
    );
    const row = selectStmt.get(id) as InterventionRow | undefined;
    if (!row) return null;
    if (row.delivered_at !== null) return null;
    if (row.kind !== 'question_required') return null;
    const payload = this.parsePayload(row.payload_json);
    const cleaned: { choice?: string; freetext?: string } = {};
    if (typeof answer.choice === 'string' && answer.choice.length > 0) {
      cleaned.choice = answer.choice;
    }
    if (typeof answer.freetext === 'string' && answer.freetext.length > 0) {
      cleaned.freetext = answer.freetext;
    }
    payload.question_answer = cleaned;
    const nowTs = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE interventions SET payload_json = ?, delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
      )
      .run(JSON.stringify(payload), nowTs, id);
    const updated = selectStmt.get(id) as InterventionRow;
    return this.rowToWire(updated);
  }

  /**
   * Count pending (undelivered) interventions for a workstream, optionally
   * scoped to a single kind. Used by the digest projection so workstreams
   * with a pending `approval_required` count toward `needs_attention` even
   * if they have no `blocked` event.
   */
  countPending(workstreamId: string, kind?: InterventionKind): number {
    const stmt = kind
      ? this.db.prepare(
          'SELECT COUNT(*) AS n FROM interventions WHERE workstream_id = ? AND kind = ? AND delivered_at IS NULL',
        )
      : this.db.prepare(
          'SELECT COUNT(*) AS n FROM interventions WHERE workstream_id = ? AND delivered_at IS NULL',
        );
    const row = (kind ? stmt.get(workstreamId, kind) : stmt.get(workstreamId)) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /** Test/UI helper: every intervention for a workstream, oldest first. */
  all(workstreamId: string, limit?: number): Intervention[] {
    const stmt = limit
      ? this.db.prepare(
          'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE workstream_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
        )
      : this.db.prepare(
          'SELECT id, workstream_id, kind, payload_json, created_at, delivered_at FROM interventions WHERE workstream_id = ? ORDER BY created_at ASC, id ASC',
        );
    const rows = (
      limit ? stmt.all(workstreamId, limit) : stmt.all(workstreamId)
    ) as InterventionRow[];
    return rows.map((r) => this.rowToWire(r));
  }

  private rowToWire(row: InterventionRow): Intervention {
    return {
      id: row.id,
      workstream_id: row.workstream_id,
      kind: row.kind,
      payload: this.parsePayload(row.payload_json),
      created_at: row.created_at,
      delivered_at: row.delivered_at,
    };
  }

  private parsePayload(json: string): InterventionPayload {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as InterventionPayload;
      }
      return {};
    } catch {
      return {};
    }
  }
}
