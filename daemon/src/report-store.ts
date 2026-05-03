import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';

export type ReportStatus = 'draft' | 'saved' | 'archived';

/**
 * Wire-format Report served by `/reports[*]` endpoints (snake_case JSON).
 * `workstream_ids` is a parsed array; the underlying table stores it as a
 * JSON-encoded TEXT column to avoid a many-to-many side table for v1.1.
 */
export interface Report {
  id: string;
  title: string;
  audience_preset: string | null;
  audience_freetext: string | null;
  period_since: string;
  period_until: string;
  workstream_ids: string[];
  provider: string;
  model: string | null;
  body_md: string;
  status: ReportStatus;
  generated_at: string;
  saved_at: string | null;
}

export interface CreateReportArgs {
  id?: string;
  title: string;
  audience_preset?: string | null;
  audience_freetext?: string | null;
  period_since: string;
  period_until: string;
  workstream_ids: string[];
  provider: string;
  model?: string | null;
  body_md: string;
  status: ReportStatus;
  generated_at?: string;
  saved_at?: string | null;
}

export interface ListReportsArgs {
  status?: ReportStatus;
  limit?: number;
}

export interface UpdateReportFields {
  title?: string;
  body_md?: string;
  status?: ReportStatus;
}

interface ReportRow {
  id: string;
  title: string;
  audience_preset: string | null;
  audience_freetext: string | null;
  period_since: string;
  period_until: string;
  workstream_ids_json: string;
  provider: string;
  model: string | null;
  body_md: string;
  status: ReportStatus;
  generated_at: string;
  saved_at: string | null;
}

const DEFAULT_LIST_LIMIT = 100;

/**
 * SQLite-backed store of generated reports. Lives in the same
 * `~/.claude/manager/db.sqlite` as the registry / queue / proposals stores.
 * Mirrors `WorkstreamRegistry` / `InterventionQueue` shape: own connection,
 * WAL pragmas, lazy migrate.
 *
 * `list()` filters to `status != 'archived'` by default so soft-deleted
 * reports stay out of the macOS app's Updates inbox unless explicitly asked
 * for via `?status=archived`.
 */
export class ReportStore {
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
      CREATE TABLE IF NOT EXISTS reports (
        id                  TEXT PRIMARY KEY,
        title               TEXT NOT NULL,
        audience_preset     TEXT,
        audience_freetext   TEXT,
        period_since        TEXT NOT NULL,
        period_until        TEXT NOT NULL,
        workstream_ids_json TEXT NOT NULL,
        provider            TEXT NOT NULL,
        model               TEXT,
        body_md             TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('draft','saved','archived')),
        generated_at        TEXT NOT NULL,
        saved_at            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reports_status_generated
        ON reports(status, generated_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  create(args: CreateReportArgs): Report {
    const id = args.id ?? `rep_${randomUUID().slice(0, 8)}`;
    const generatedAt = args.generated_at ?? new Date().toISOString();
    const savedAt = args.saved_at ?? (args.status === 'saved' ? generatedAt : null);
    const workstreamIdsJson = JSON.stringify(args.workstream_ids ?? []);
    this.db
      .prepare(
        `INSERT INTO reports (
          id, title, audience_preset, audience_freetext, period_since, period_until,
          workstream_ids_json, provider, model, body_md, status, generated_at, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.title,
        args.audience_preset ?? null,
        args.audience_freetext ?? null,
        args.period_since,
        args.period_until,
        workstreamIdsJson,
        args.provider,
        args.model ?? null,
        args.body_md,
        args.status,
        generatedAt,
        savedAt,
      );
    const got = this.get(id);
    if (!got) {
      throw new Error(`failed to read back report ${id}`);
    }
    return got;
  }

  /**
   * List reports. By default hides `archived` rows; pass `status: 'archived'`
   * to fetch them explicitly. Ordered by `generated_at DESC`.
   */
  list(args: ListReportsArgs = {}): Report[] {
    const limit = args.limit ?? DEFAULT_LIST_LIMIT;
    let rows: ReportRow[];
    if (args.status) {
      rows = this.db
        .prepare(
          `SELECT id, title, audience_preset, audience_freetext, period_since, period_until,
                  workstream_ids_json, provider, model, body_md, status, generated_at, saved_at
           FROM reports
           WHERE status = ?
           ORDER BY generated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(args.status, limit) as ReportRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT id, title, audience_preset, audience_freetext, period_since, period_until,
                  workstream_ids_json, provider, model, body_md, status, generated_at, saved_at
           FROM reports
           WHERE status != 'archived'
           ORDER BY generated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as ReportRow[];
    }
    return rows.map((r) => rowToWire(r));
  }

  get(id: string): Report | null {
    const row = this.db
      .prepare(
        `SELECT id, title, audience_preset, audience_freetext, period_since, period_until,
                workstream_ids_json, provider, model, body_md, status, generated_at, saved_at
         FROM reports
         WHERE id = ?`,
      )
      .get(id) as ReportRow | undefined;
    return row ? rowToWire(row) : null;
  }

  /**
   * Patch one of `title`, `body_md`, `status`. When `status` flips to
   * `'saved'`, sets `saved_at = now()` (idempotent — re-saving updates
   * `saved_at`). Returns the updated row, or `null` if the id is unknown.
   */
  update(id: string, fields: UpdateReportFields): Report | null {
    const existing = this.get(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (fields.title !== undefined) {
      sets.push('title = ?');
      values.push(fields.title);
    }
    if (fields.body_md !== undefined) {
      sets.push('body_md = ?');
      values.push(fields.body_md);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      values.push(fields.status);
      if (fields.status === 'saved') {
        sets.push('saved_at = ?');
        values.push(new Date().toISOString());
      }
    }
    if (sets.length === 0) return existing;
    values.push(id);
    this.db.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  }
}

function rowToWire(row: ReportRow): Report {
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.workstream_ids_json);
    if (Array.isArray(parsed)) {
      ids = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    ids = [];
  }
  return {
    id: row.id,
    title: row.title,
    audience_preset: row.audience_preset,
    audience_freetext: row.audience_freetext,
    period_since: row.period_since,
    period_until: row.period_until,
    workstream_ids: ids,
    provider: row.provider,
    model: row.model,
    body_md: row.body_md,
    status: row.status,
    generated_at: row.generated_at,
    saved_at: row.saved_at,
  };
}
