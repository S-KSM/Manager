import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';

/**
 * v1.2 Linear-link store. Persists the (workstream → tracker issue)
 * association used by the macOS Linear chip and the bidirectional sync
 * ticker.
 *
 * Two tables:
 *
 *   - `workstream_links` — one row per linked workstream (PK is workstream_id
 *     so a workstream has at most one active link).
 *   - `linear_comments_posted` — set-membership for "we already posted a
 *     decision-as-comment for this decision id". Lets the comment syncer
 *     stay idempotent across daemon restarts without re-walking Linear's
 *     comment list.
 */
export type TrackerKind = 'linear';

export interface WorkstreamLink {
  workstream_id: string;
  tracker_kind: TrackerKind;
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  last_seen_state: string | null;
  last_synced_at: string | null;
  created_at: string;
}

interface LinkRow {
  workstream_id: string;
  tracker_kind: TrackerKind;
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  last_seen_state: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface LinkInput {
  workstreamId: string;
  trackerKind: TrackerKind;
  issueId: string;
  issueIdentifier: string;
  issueUrl?: string | null;
  /** Initial state from the tracker. Stored verbatim. */
  lastSeenState?: string | null;
}

export class WorkstreamLinksStore {
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
      CREATE TABLE IF NOT EXISTS workstream_links (
        workstream_id    TEXT PRIMARY KEY,
        tracker_kind     TEXT NOT NULL,
        issue_id         TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        issue_url        TEXT,
        last_seen_state  TEXT,
        last_synced_at   TEXT,
        created_at       TEXT NOT NULL,
        FOREIGN KEY (workstream_id) REFERENCES workstreams(id)
      );
      CREATE INDEX IF NOT EXISTS idx_links_issue ON workstream_links(issue_id);
      CREATE TABLE IF NOT EXISTS linear_comments_posted (
        decision_id   TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL,
        posted_at     TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Idempotent upsert: re-linking a workstream replaces the prior row. */
  link(input: LinkInput): WorkstreamLink {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workstream_links
           (workstream_id, tracker_kind, issue_id, issue_identifier, issue_url,
            last_seen_state, last_synced_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(workstream_id) DO UPDATE SET
           tracker_kind     = excluded.tracker_kind,
           issue_id         = excluded.issue_id,
           issue_identifier = excluded.issue_identifier,
           issue_url        = excluded.issue_url,
           last_seen_state  = excluded.last_seen_state,
           last_synced_at   = NULL`,
      )
      .run(
        input.workstreamId,
        input.trackerKind,
        input.issueId,
        input.issueIdentifier,
        input.issueUrl ?? null,
        input.lastSeenState ?? null,
        now,
      );
    const got = this.get(input.workstreamId);
    if (!got) {
      // Should never happen — INSERT ON CONFLICT always leaves a row behind.
      throw new Error('workstream_links: INSERT did not produce a row');
    }
    return got;
  }

  /** Idempotent: deleting a non-existent link is a no-op. */
  unlink(workstreamId: string): void {
    this.db.prepare('DELETE FROM workstream_links WHERE workstream_id = ?').run(workstreamId);
  }

  get(workstreamId: string): WorkstreamLink | null {
    const row = this.db
      .prepare(
        `SELECT workstream_id, tracker_kind, issue_id, issue_identifier, issue_url,
                last_seen_state, last_synced_at, created_at
         FROM workstream_links
         WHERE workstream_id = ?`,
      )
      .get(workstreamId) as LinkRow | undefined;
    return row ? this.rowToWire(row) : null;
  }

  /**
   * v1.4.12 — Reverse lookup so the tracker mirror can ask "is this issue
   * already represented by a workstream?" without scanning. The
   * `idx_links_issue` index makes this O(log N).
   */
  findByIssueId(issueId: string): WorkstreamLink | null {
    const row = this.db
      .prepare(
        `SELECT workstream_id, tracker_kind, issue_id, issue_identifier, issue_url,
                last_seen_state, last_synced_at, created_at
         FROM workstream_links
         WHERE issue_id = ?
         LIMIT 1`,
      )
      .get(issueId) as LinkRow | undefined;
    return row ? this.rowToWire(row) : null;
  }

  list(): WorkstreamLink[] {
    const rows = this.db
      .prepare(
        `SELECT workstream_id, tracker_kind, issue_id, issue_identifier, issue_url,
                last_seen_state, last_synced_at, created_at
         FROM workstream_links
         ORDER BY created_at ASC`,
      )
      .all() as LinkRow[];
    return rows.map((r) => this.rowToWire(r));
  }

  setLastSeenState(workstreamId: string, state: string): void {
    this.db
      .prepare('UPDATE workstream_links SET last_seen_state = ? WHERE workstream_id = ?')
      .run(state, workstreamId);
  }

  setLastSyncedAt(workstreamId: string, ts: string = new Date().toISOString()): void {
    this.db
      .prepare('UPDATE workstream_links SET last_synced_at = ? WHERE workstream_id = ?')
      .run(ts, workstreamId);
  }

  /** Set membership: was a Linear comment already posted for this decision? */
  hasCommentPosted(decisionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS one FROM linear_comments_posted WHERE decision_id = ?')
      .get(decisionId) as { one: number } | undefined;
    return !!row;
  }

  /** Idempotent: re-marking is a no-op (PRIMARY KEY conflict ignored). */
  markCommentPosted(decisionId: string, workstreamId: string): void {
    this.db
      .prepare(
        `INSERT INTO linear_comments_posted (decision_id, workstream_id, posted_at)
         VALUES (?, ?, ?)
         ON CONFLICT(decision_id) DO NOTHING`,
      )
      .run(decisionId, workstreamId, new Date().toISOString());
  }

  private rowToWire(row: LinkRow): WorkstreamLink {
    return {
      workstream_id: row.workstream_id,
      tracker_kind: row.tracker_kind,
      issue_id: row.issue_id,
      issue_identifier: row.issue_identifier,
      issue_url: row.issue_url,
      last_seen_state: row.last_seen_state,
      last_synced_at: row.last_synced_at,
      created_at: row.created_at,
    };
  }
}
