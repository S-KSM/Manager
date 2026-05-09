import { readFile } from 'node:fs/promises';
import {
  type AssigneeFilter,
  type ClaimOptions,
  type Issue,
  type Tracker,
  TrackerError,
} from './index.js';

/**
 * MockTracker — reads issues from a JSON file. Two purposes:
 *
 *  1. Test harness for the orchestrator state machine without Linear creds.
 *  2. Blueprint for the in-app `kanban` adapter (v1.4.x +) — same interface,
 *     just swap the JSON file for a SQLite read against the kanban table.
 *
 * The source file is re-read on every `fetchCandidateIssues` call so a test
 * can mutate it between ticks without restarting the daemon.
 *
 * Source file shape:
 *   { "issues": [ Issue, Issue, ... ] }
 *
 * Where each Issue is the Symphony §4.1.1 wire shape (snake_case keys).
 */
export class MockTracker implements Tracker {
  readonly kind = 'mock';
  private readonly source: string;
  /**
   * v1.4.7 — In-memory assignee map keyed by issue.id. Tests inspect it via
   * `claimedAssignees`. The mock JSON file stays read-only; claim/release
   * effects live only here.
   */
  private readonly assignees = new Map<string, string | null>();
  /** v1.4.7 — Stable id returned by `selfUserId()` so 'self' filter works in tests. */
  private readonly selfId: string;

  constructor(source: string, opts?: { selfUserId?: string }) {
    this.source = source;
    this.selfId = opts?.selfUserId ?? 'mock-self';
  }

  async selfUserId(): Promise<string> {
    return this.selfId;
  }

  /** Inspect what the orchestrator has claimed. Test-only. */
  claimedAssignees(): ReadonlyMap<string, string | null> {
    return this.assignees;
  }

  async fetchCandidateIssues(
    activeStates: string[],
    opts?: { assigneeFilter?: AssigneeFilter },
  ): Promise<Issue[]> {
    const all = await this.readAll();
    const set = new Set(activeStates.map((s) => s.toLowerCase()));
    const filter = opts?.assigneeFilter ?? 'any';
    return all.filter((i) => {
      if (!set.has(i.state.toLowerCase())) return false;
      if (filter === 'any') return true;
      const a = this.assignees.get(i.id) ?? null;
      if (filter === 'unassigned') return a === null;
      if (filter === 'self') return a === this.selfId;
      // 'unassigned_or_self'
      return a === null || a === this.selfId;
    });
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const all = await this.readAll();
    const set = new Set(stateNames.map((s) => s.toLowerCase()));
    return all.filter((i) => set.has(i.state.toLowerCase()));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>> {
    const all = await this.readAll();
    const wanted = new Set(issueIds);
    const out = new Map<string, string>();
    for (const i of all) {
      if (wanted.has(i.id)) out.set(i.id, i.state);
    }
    return out;
  }

  async claimIssue(issueId: string, opts: ClaimOptions): Promise<void> {
    const desired = opts.assigneeId === undefined ? this.selfId : opts.assigneeId;
    const current = this.assignees.get(issueId) ?? null;
    if (current && desired && current !== desired) {
      throw new TrackerError(
        'linear_assignee_taken',
        `Mock issue ${issueId} already assigned to ${current}`,
      );
    }
    this.assignees.set(issueId, desired);
  }

  async releaseIssue(issueId: string, opts?: ClaimOptions): Promise<void> {
    const desired = opts?.assigneeId === undefined ? null : opts.assigneeId;
    this.assignees.set(issueId, desired);
  }

  /**
   * v1.4.10.1 — Mock returns the name back as the id (the JSON fixture's
   * `state` field is already the human-readable name, so identity is the
   * cheapest plausible mapping for tests).
   */
  async resolveStateIdByName(name: string): Promise<string | null> {
    return name;
  }

  /**
   * v1.4.10.5 — Mock has no notion of `updatedAt`, so it returns *all*
   * self-claimed active issues regardless of age. Tests that need stale-
   * vs-fresh discrimination should drive the orchestrator's running map
   * directly — the sweeper filters on that anyway.
   */
  async fetchStaleSelfClaimedIssues(activeStates: string[], _ttlMs: number): Promise<Issue[]> {
    const all = await this.readAll();
    const set = new Set(activeStates.map((s) => s.toLowerCase()));
    return all.filter((i) => {
      if (!set.has(i.state.toLowerCase())) return false;
      return (this.assignees.get(i.id) ?? null) === this.selfId;
    });
  }

  private async readAll(): Promise<Issue[]> {
    let raw: string;
    try {
      raw = await readFile(this.source, 'utf8');
    } catch (err) {
      throw new TrackerError(
        'mock_source_missing',
        `MockTracker source not readable at ${this.source}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TrackerError(
        'mock_source_invalid',
        `MockTracker source ${this.source} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new TrackerError(
        'mock_source_invalid',
        `MockTracker source ${this.source} did not parse to an object`,
      );
    }
    const issues = (parsed as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) {
      throw new TrackerError(
        'mock_source_invalid',
        `MockTracker source ${this.source} missing "issues" array`,
      );
    }
    const out: Issue[] = [];
    for (const raw of issues) {
      const norm = normalize(raw);
      if (norm) out.push(norm);
    }
    return out;
  }
}

function normalize(raw: unknown): Issue | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = stringOrNull(r['id']);
  const identifier = stringOrNull(r['identifier']);
  const title = stringOrNull(r['title']);
  const state = stringOrNull(r['state']);
  if (!id || !identifier || !title || !state) return null;
  const labelsRaw = Array.isArray(r['labels']) ? r['labels'] : [];
  const labels = labelsRaw
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.toLowerCase());
  const blockersRaw = Array.isArray(r['blocked_by']) ? r['blocked_by'] : [];
  const blocked_by = blockersRaw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((b) => ({
      id: stringOrNull(b['id']),
      identifier: stringOrNull(b['identifier']),
      state: stringOrNull(b['state']),
    }));
  const priority = numberOrNull(r['priority']);
  return {
    id,
    identifier,
    title,
    description: stringOrNull(r['description']),
    priority,
    state,
    branch_name: stringOrNull(r['branch_name']),
    url: stringOrNull(r['url']),
    labels,
    blocked_by,
    created_at: stringOrNull(r['created_at']),
    updated_at: stringOrNull(r['updated_at']),
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
