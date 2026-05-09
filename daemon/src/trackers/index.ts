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
