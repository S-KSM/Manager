import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';

export type SkillProposalStatus = 'proposed' | 'promoted' | 'dismissed';

/**
 * Wire-format SkillProposal — snake_case JSON shipped over HTTP to clients
 * and stored verbatim (modulo bookkeeping columns) in the SQLite table.
 */
export interface SkillProposal {
  id: string;
  workstream_id: string;
  title: string;
  body: string;
  source_decision_id: string | null;
  proposed_at: string;
  status: SkillProposalStatus;
}

interface ProposalRow {
  id: string;
  workstream_id: string;
  title: string;
  body: string;
  source_decision_id: string | null;
  proposed_at: string;
  status: SkillProposalStatus;
}

export interface ProposeArgs {
  workstream_id: string;
  title: string;
  body: string;
  source_decision_id?: string;
}

/**
 * SQLite-backed store of agent-proposed skills awaiting manager review. Lives
 * in the same `~/.claude/manager/db.sqlite` as the registry/queue. Mirrors the
 * `InterventionQueue` shape (own connection, WAL, optional `dbPath`).
 */
export class SkillProposalsStore {
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
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id                 TEXT PRIMARY KEY,
        workstream_id      TEXT NOT NULL,
        title              TEXT NOT NULL,
        body               TEXT NOT NULL,
        source_decision_id TEXT,
        proposed_at        TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('proposed','promoted','dismissed'))
      );
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_status
        ON skill_proposals(status, proposed_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  propose(args: ProposeArgs): SkillProposal {
    const id = `prop_${randomUUID().slice(0, 8)}`;
    const proposedAt = new Date().toISOString();
    const sourceDecisionId = args.source_decision_id ?? null;
    this.db
      .prepare(
        'INSERT INTO skill_proposals (id, workstream_id, title, body, source_decision_id, proposed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, args.workstream_id, args.title, args.body, sourceDecisionId, proposedAt, 'proposed');
    return {
      id,
      workstream_id: args.workstream_id,
      title: args.title,
      body: args.body,
      source_decision_id: sourceDecisionId,
      proposed_at: proposedAt,
      status: 'proposed',
    };
  }

  /** Pending proposals, oldest first. */
  listProposed(): SkillProposal[] {
    const rows = this.db
      .prepare(
        "SELECT id, workstream_id, title, body, source_decision_id, proposed_at, status FROM skill_proposals WHERE status = 'proposed' ORDER BY proposed_at ASC, id ASC",
      )
      .all() as ProposalRow[];
    return rows.map((r) => this.rowToWire(r));
  }

  get(id: string): SkillProposal | null {
    const row = this.db
      .prepare(
        'SELECT id, workstream_id, title, body, source_decision_id, proposed_at, status FROM skill_proposals WHERE id = ?',
      )
      .get(id) as ProposalRow | undefined;
    return row ? this.rowToWire(row) : null;
  }

  markPromoted(id: string): SkillProposal | null {
    return this.updateStatus(id, 'promoted');
  }

  markDismissed(id: string): SkillProposal | null {
    return this.updateStatus(id, 'dismissed');
  }

  private updateStatus(id: string, status: SkillProposalStatus): SkillProposal | null {
    const result = this.db
      .prepare('UPDATE skill_proposals SET status = ? WHERE id = ?')
      .run(status, id);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  private rowToWire(row: ProposalRow): SkillProposal {
    return {
      id: row.id,
      workstream_id: row.workstream_id,
      title: row.title,
      body: row.body,
      source_decision_id: row.source_decision_id,
      proposed_at: row.proposed_at,
      status: row.status,
    };
  }
}
