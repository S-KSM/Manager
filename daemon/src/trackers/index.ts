/**
 * Tracker abstraction adopted from OpenAI Symphony SPEC.md §11.1.
 *
 * A tracker is the source of work that drives the orchestrator. The first
 * shipped adapter is `mock` (SQLite-backed, used for tests + local dev). The
 * second is `linear` (v1.4.3). Future: `kanban` (in-app board), `github_issues`.
 *
 * Implementations MUST be pure data adapters — no orchestration, no spawn, no
 * intervention logic. They normalize tracker-specific shapes into Symphony's
 * `Issue` (§4.1.1) and surface error categories the orchestrator can reason
 * about (§11.4).
 */

/** Symphony §4.1.1 — normalized issue used by orchestrator + prompt rendering. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  /** Lower numbers are higher priority in dispatch sorting. null sorts last. */
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  /** Lowercased. */
  labels: string[];
  blocked_by: BlockerRef[];
  /** ISO-8601 or null. */
  created_at: string | null;
  /** ISO-8601 or null. */
  updated_at: string | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * v1.4.7 — Filter applied at fetch time so two daemons don't race the same
 * issue.
 *
 * v1.4.10.2 — `'unassigned_or_self'` added so a daemon that crashed mid-claim
 * still re-discovers its own zombie tickets on restart. This is the default
 * the orchestrator uses when `tracker.unassigned_only` is on; strict
 * `'unassigned'` is kept on the union for callers that explicitly want it.
 */
export type AssigneeFilter = 'any' | 'unassigned' | 'self' | 'unassigned_or_self';

/** v1.4.7 — Optional knobs on a claim/release write. */
export interface ClaimOptions {
  /** Tracker-native state id (already resolved from a name). Null/undef = leave state alone. */
  stateId?: string | null;
  /**
   * v1.4.10.4 — Raw state name. When the adapter supports per-issue/team
   * resolution (Linear), this is preferred over `stateId` because it lets the
   * adapter pick the right state for the *issue's* team in a multi-team
   * project. Adapters that don't support per-team resolution (mock) ignore
   * this and use `stateId`. Both can be passed; adapter chooses.
   */
  stateName?: string | null;
  /** Tracker-native user id. Null = clear assignee. Undef = leave assignee alone. */
  assigneeId?: string | null;
}

/** Symphony §11.1 — REQUIRED tracker operations + v1.4.7 optional write ops. */
export interface Tracker {
  readonly kind: string;
  /** Issues whose state is in the configured `active_states`. */
  fetchCandidateIssues(
    activeStates: string[],
    opts?: { assigneeFilter?: AssigneeFilter },
  ): Promise<Issue[]>;
  /** Used by §8.6 startup terminal cleanup. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** Used by §8.5 active-run reconciliation. Map keyed by issue.id. */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>>;
  /**
   * v1.4.7 — Write operations. Optional on the interface so observation-only
   * trackers don't need to implement them; orchestrator probes for presence
   * before calling. Implementors that DO support claim should also support
   * release so a failed run doesn't leave a ticket assigned forever.
   */
  claimIssue?(issueId: string, opts: ClaimOptions): Promise<void>;
  releaseIssue?(issueId: string, opts?: ClaimOptions): Promise<void>;
  /**
   * v1.4.10.1 — Resolve a tracker-specific state name to its native id.
   * Returns null when the name isn't recognized. Called once at boot per
   * `WORKFLOW.md` `tracker.claim_state` value; the result is closed over by
   * the claim hook so the per-claim path stays one round-trip.
   *
   * v1.4.10.4 — Optional `teamId` arg lets multi-team Linear projects
   * resolve the same state name to different ids per team. Adapters that
   * ignore the arg (mock) keep their single-cache behavior.
   */
  resolveStateIdByName?(name: string, opts?: { teamId?: string }): Promise<string | null>;
  /**
   * v1.4.10.5 — Find issues currently assigned to `selfUserId()` whose
   * `updatedAt` is older than `ttlMs` ago AND whose state is in the
   * `activeStates` list. The orchestrator's stale-claim sweeper releases
   * any returned issues that are NOT in its local `running` map, on the
   * theory that the previous owner crashed mid-claim and the ticket should
   * go back to the queue.
   *
   * Adapters without a notion of `updatedAt` (mock) MAY return all
   * self-claimed active issues regardless of age.
   */
  fetchStaleSelfClaimedIssues?(activeStates: string[], ttlMs: number): Promise<Issue[]>;
  /**
   * v1.4.11 — File a brand-new ticket. Returned `id` is the tracker-native
   * id (Linear UUID); `identifier` is the human-readable key (`ENG-123`);
   * `url` points at the ticket in the tracker's web UI when available.
   *
   * Adapters that don't support ticket creation (mock can fake it; real
   * read-only trackers should omit the method) leave the orchestrator to
   * 501 the corresponding HTTP/MCP path.
   */
  createIssue?(input: CreateIssueInput): Promise<CreateIssueResult>;
}

/** v1.4.11 — Inputs for `createIssue`. Mirrors Linear's IssueCreateInput. */
export interface CreateIssueInput {
  title: string;
  description?: string | null;
  /** Lowercased label names. Adapter resolves to native ids. Unknown names ignored. */
  labels?: string[];
  /** Linear priority: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority?: number | null;
  /** Optional explicit team id; adapter falls back to the project's primary team. */
  teamId?: string | null;
}

export interface CreateIssueResult {
  id: string;
  identifier: string;
  url: string | null;
}

/**
 * Symphony §11.4 normalized error categories. Wrapped exceptions carry one of
 * these so the orchestrator can decide whether to skip-this-tick (transient) or
 * fail-startup (config).
 */
export type TrackerErrorCode =
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor'
  | 'linear_unknown_identifier'
  | 'linear_state_not_found'
  | 'linear_comment_failed'
  | 'linear_assignee_taken'
  | 'linear_self_user_failed'
  | 'mock_source_missing'
  | 'mock_source_invalid';

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  constructor(code: TrackerErrorCode, message: string) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
  }
}
