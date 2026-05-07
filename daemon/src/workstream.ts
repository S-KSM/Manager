import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';

export type WorkstreamStatus = 'backlog' | 'active' | 'paused' | 'retired';

export interface Workstream {
  id: string;
  title: string;
  status: WorkstreamStatus;
  createdAt: string;
}

export interface SessionRow {
  sessionId: string;
  workstreamId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface WorkstreamWithSessions extends Workstream {
  sessions: SessionRow[];
}

/**
 * SQLite-backed registry. Schema is intentionally minimal — the JSONL event
 * store is the source of truth for activity; this table is just an index over
 * "what workstreams exist" and "which sessions belong to each".
 */
export class WorkstreamRegistry {
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
      CREATE TABLE IF NOT EXISTS workstreams (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY (workstream_id) REFERENCES workstreams(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  create(id: string, title: string, status: WorkstreamStatus = 'active'): Workstream {
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO workstreams (id, title, status, created_at) VALUES (?, ?, ?, ?)')
      .run(id, title, status, createdAt);
    return { id, title, status, createdAt };
  }

  /** Insert if absent; otherwise return existing. Useful from hooks/MCP. */
  ensure(id: string, title?: string): Workstream {
    const existing = this.get(id);
    if (existing) return existing;
    return this.create(id, title ?? id);
  }

  get(id: string): Workstream | null {
    const row = this.db
      .prepare('SELECT id, title, status, created_at FROM workstreams WHERE id = ?')
      .get(id) as
      | { id: string; title: string; status: WorkstreamStatus; created_at: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, title: row.title, status: row.status, createdAt: row.created_at };
  }

  list(): Workstream[] {
    const rows = this.db
      .prepare('SELECT id, title, status, created_at FROM workstreams ORDER BY created_at ASC')
      .all() as { id: string; title: string; status: WorkstreamStatus; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  setStatus(id: string, status: WorkstreamStatus): void {
    this.db.prepare('UPDATE workstreams SET status = ? WHERE id = ?').run(status, id);
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE workstreams SET title = ? WHERE id = ?').run(title, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE workstream_id = ?').run(id);
    this.db.prepare('DELETE FROM workstreams WHERE id = ?').run(id);
  }

  startSession(
    sessionId: string,
    workstreamId: string,
    startedAt = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sessions (session_id, workstream_id, started_at, ended_at) VALUES (?, ?, ?, NULL)',
      )
      .run(sessionId, workstreamId, startedAt);
  }

  endSession(sessionId: string, endedAt = new Date().toISOString()): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ? WHERE session_id = ?')
      .run(endedAt, sessionId);
  }

  sessionsFor(workstreamId: string): SessionRow[] {
    const rows = this.db
      .prepare(
        'SELECT session_id, workstream_id, started_at, ended_at FROM sessions WHERE workstream_id = ? ORDER BY started_at ASC',
      )
      .all(workstreamId) as {
      session_id: string;
      workstream_id: string;
      started_at: string;
      ended_at: string | null;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      workstreamId: r.workstream_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  detail(id: string): WorkstreamWithSessions | null {
    const ws = this.get(id);
    if (!ws) return null;
    return { ...ws, sessions: this.sessionsFor(id) };
  }
}
