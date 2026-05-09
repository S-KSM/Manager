import {
  type AssigneeFilter,
  type BlockerRef,
  type ClaimOptions,
  type Issue,
  type Tracker,
  TrackerError,
} from './index.js';

/**
 * LinearTracker — Symphony SPEC.md §11.2 (Linear-compatible).
 *
 * GraphQL endpoint, auth via `Authorization` header (the API key is the bare
 * token — no `Bearer ` prefix, per Linear's docs).
 *
 * v1.4.3 ships the three required operations (Symphony §11.1) plus
 * pagination on candidate fetch (page size 50, network timeout 30s).
 *
 * Schema-drift posture: query construction lives only in this file; if Linear
 * changes a field name we change exactly one place.
 */

const NETWORK_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;

/**
 * v1.4.7 — `$assigneeFilter` is composed in TS and inlined as a literal map.
 * Linear's GraphQL schema does not let us pass `null` through a typed variable
 * for "is null", so the filter clause is built as a string fragment outside
 * the query template.
 */
function buildCandidateQuery(assigneeClause: string): string {
  return `
    query CandidateIssues($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
      issues(
        first: $first
        after: $after
        filter: {
          project: { slugId: { eq: $projectSlug } }
          state: { name: { in: $states } }
          ${assigneeClause}
        }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id identifier title description priority url branchName createdAt updatedAt
          labels { nodes { name } }
          state { name }
          assignee { id }
          inverseRelations(first: 50, filter: { type: { eq: "blocks" } }) {
            nodes {
              issue { id identifier state { name } }
            }
          }
        }
      }
    }
  `;
}

const STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $states: [String!]!, $first: Int!) {
    issues(
      first: $first
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
    ) {
      nodes {
        id identifier title description priority url branchName createdAt updatedAt
        labels { nodes { name } }
        state { name }
      }
    }
  }
`;

const STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }, first: 250) {
      nodes { id state { name } }
    }
  }
`;

const ISSUE_BY_IDENTIFIER_QUERY = `
  query IssueByIdentifier($identifier: String!) {
    issues(filter: { identifier: { eq: $identifier } }, first: 1) {
      nodes {
        id identifier title description priority url branchName createdAt updatedAt
        labels { nodes { name } }
        state { name }
      }
    }
  }
`;

const SET_ISSUE_STATE_MUTATION = `
  mutation SetIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue { id state { id name } }
    }
  }
`;

const VIEWER_QUERY = `query Viewer { viewer { id } }`;

/**
 * v1.4.7 — Read assignee + state right before claim mutate so we can detect
 * "someone else got there first". `linear_assignee_taken` is thrown when the
 * fetched `assignee.id` is non-null and != the user we'd assign to.
 */
const ISSUE_ASSIGNEE_QUERY = `
  query IssueAssignee($id: String!) {
    issue(id: $id) {
      id
      assignee { id }
      state { id name }
    }
  }
`;

/**
 * v1.4.7 — Generalized issueUpdate. AssigneeId / stateId both optional so a
 * caller can flip either or both. Linear treats `null` as "clear" for
 * assignee. Omitting a key leaves the field alone.
 */
const UPDATE_ISSUE_MUTATION = `
  mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $issueId, input: $input) {
      success
      issue { id assignee { id } state { id name } }
    }
  }
`;

const ADD_ISSUE_COMMENT_MUTATION = `
  mutation AddIssueComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

/**
 * v1.4.10.1 — Resolve workflow states by walking through one issue in the
 * configured project. Linear projects can span multiple teams, but in the
 * dominant single-team case this query returns the full state list with one
 * round-trip. Used by `resolveStateIdByName` so `WORKFLOW.md`'s
 * `tracker.claim_state: "In Progress"` can be turned into a stateId.
 */
const PROJECT_TEAM_STATES_QUERY = `
  query ProjectTeamStates($projectSlug: String!) {
    issues(filter: { project: { slugId: { eq: $projectSlug } } }, first: 1) {
      nodes {
        team {
          id
          states { nodes { id name } }
        }
      }
    }
  }
`;

export interface LinearTrackerOptions {
  apiKey: string;
  projectSlug: string;
  endpoint?: string;
  /** Override fetch — used by tests. */
  fetchImpl?: typeof fetch;
}

export class LinearTracker implements Tracker {
  readonly kind = 'linear';
  private readonly apiKey: string;
  private readonly projectSlug: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  /** v1.4.7 — cached `viewer.id` resolved on first claim/filter-by-self. */
  private cachedSelfUserId: string | null = null;
  /**
   * v1.4.10.1 — cached workflow-states map for this project's primary team,
   * keyed by lowercased state name. Filled lazily by `resolveStateIdByName`.
   * `null` after a successful resolve that returned an empty map means the
   * project has no issues yet (we re-query on the next call).
   */
  private cachedStateIdByName: Map<string, string> | null = null;

  constructor(opts: LinearTrackerOptions) {
    if (!opts.apiKey) {
      throw new TrackerError('missing_tracker_api_key', 'Linear tracker requires api_key');
    }
    if (!opts.projectSlug) {
      throw new TrackerError(
        'missing_tracker_project_slug',
        'Linear tracker requires project_slug',
      );
    }
    this.apiKey = opts.apiKey;
    this.projectSlug = opts.projectSlug;
    this.endpoint = opts.endpoint ?? 'https://api.linear.app/graphql';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchCandidateIssues(
    activeStates: string[],
    opts?: { assigneeFilter?: AssigneeFilter },
  ): Promise<Issue[]> {
    const filter = opts?.assigneeFilter ?? 'any';
    let assigneeClause = '';
    if (filter === 'unassigned') {
      assigneeClause = 'assignee: { null: { eq: true } }';
    } else if (filter === 'self') {
      const selfId = await this.selfUserId();
      // GraphQL string interpolation is safe here: selfId comes from Linear, never user input.
      assigneeClause = `assignee: { id: { eq: "${selfId}" } }`;
    }
    const query = buildCandidateQuery(assigneeClause);
    const out: Issue[] = [];
    let after: string | null = null;
    // Hard cap pagination at 20 pages so a misconfigured project can't run away.
    for (let i = 0; i < 20; i++) {
      const data: CandidatesPayload = await this.gql<CandidatesPayload>(query, {
        projectSlug: this.projectSlug,
        states: activeStates,
        first: PAGE_SIZE,
        after,
      });
      for (const node of data.issues.nodes) out.push(normalizeNode(node));
      if (!data.issues.pageInfo.hasNextPage) return out;
      if (data.issues.pageInfo.endCursor === null) {
        throw new TrackerError(
          'linear_missing_end_cursor',
          'Linear pagination integrity: hasNextPage=true but endCursor=null',
        );
      }
      after = data.issues.pageInfo.endCursor;
    }
    return out;
  }

  /**
   * v1.4.7 — Resolve `viewer.id` once and cache. Used by the `self` assignee
   * filter and by claimIssue when callers don't supply an assigneeId.
   */
  async selfUserId(): Promise<string> {
    if (this.cachedSelfUserId) return this.cachedSelfUserId;
    const data = await this.gql<{ viewer: { id: string } | null }>(VIEWER_QUERY, {});
    const id = data.viewer?.id;
    if (!id) {
      throw new TrackerError(
        'linear_self_user_failed',
        'Linear viewer query returned no id — check API key has user scope',
      );
    }
    this.cachedSelfUserId = id;
    return id;
  }

  /**
   * v1.4.10.1 — Map a Linear workflow-state name (case-insensitive) to its
   * tracker-native id. Returns null if the name doesn't exist in the project's
   * primary team. The CLI calls this once at boot when `tracker.claim_state`
   * is configured, so the per-claim path stays one round-trip.
   *
   * Single-team projects: cache hit on call #2. Multi-team projects: this
   * resolver only sees the team of the first issue we found, so a state name
   * that exists in a *different* team in the same project will not resolve
   * here — handle that by querying the issue's team explicitly when claim
   * fires (deferred; today's Dispatch users are all single-team).
   */
  async resolveStateIdByName(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase();
    if (this.cachedStateIdByName) {
      return this.cachedStateIdByName.get(key) ?? null;
    }
    const data = await this.gql<{
      issues: {
        nodes: Array<{
          team: { id: string; states: { nodes: Array<{ id: string; name: string }> } } | null;
        }>;
      };
    }>(PROJECT_TEAM_STATES_QUERY, { projectSlug: this.projectSlug });
    const team = data.issues?.nodes?.[0]?.team;
    if (!team) {
      // Empty project — no team known yet. Don't cache; next call retries.
      return null;
    }
    const map = new Map<string, string>();
    for (const s of team.states.nodes ?? []) {
      if (s?.name && s.id) map.set(s.name.toLowerCase(), s.id);
    }
    this.cachedStateIdByName = map;
    return map.get(key) ?? null;
  }

  /**
   * v1.4.7 — Claim an issue: read current assignee, abort with
   * `linear_assignee_taken` if a different user already holds it, otherwise
   * write assignee + (optional) state in one mutation. Caller resolves the
   * tracker-native stateId; this method does NOT do name→id mapping.
   */
  async claimIssue(issueId: string, opts: ClaimOptions): Promise<void> {
    const assigneeId = opts.assigneeId === undefined ? await this.selfUserId() : opts.assigneeId;
    if (assigneeId) {
      const peek = await this.gql<{ issue: { assignee: { id: string } | null } | null }>(
        ISSUE_ASSIGNEE_QUERY,
        { id: issueId },
      );
      const current = peek.issue?.assignee?.id ?? null;
      if (current && current !== assigneeId) {
        throw new TrackerError(
          'linear_assignee_taken',
          `Linear issue ${issueId} already assigned to ${current}`,
        );
      }
    }
    await this.applyIssueUpdate(issueId, { assigneeId, stateId: opts.stateId ?? undefined });
  }

  /**
   * v1.4.7 — Release an issue: clear assignee unless caller supplies a value
   * (passing assigneeId: undefined still clears, since release semantics are
   * "let it go"). Optional state move on the way out (e.g., back to "Todo").
   */
  async releaseIssue(issueId: string, opts?: ClaimOptions): Promise<void> {
    const assigneeId = opts?.assigneeId === undefined ? null : opts.assigneeId;
    await this.applyIssueUpdate(issueId, { assigneeId, stateId: opts?.stateId ?? undefined });
  }

  private async applyIssueUpdate(
    issueId: string,
    fields: { assigneeId?: string | null; stateId?: string | null },
  ): Promise<void> {
    const input: Record<string, unknown> = {};
    if (fields.assigneeId !== undefined) input.assigneeId = fields.assigneeId;
    if (fields.stateId !== undefined && fields.stateId !== null) input.stateId = fields.stateId;
    if (Object.keys(input).length === 0) return; // No-op write — skip the round-trip.
    const data = await this.gql<{
      issueUpdate: { success: boolean; issue: { id: string } | null };
    }>(UPDATE_ISSUE_MUTATION, { issueId, input });
    if (!data.issueUpdate?.success) {
      throw new TrackerError(
        'linear_state_not_found',
        `Linear issueUpdate did not succeed for issue=${issueId} input=${JSON.stringify(input)}`,
      );
    }
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const data = await this.gql<{ issues: { nodes: LinearIssueNode[] } }>(STATES_QUERY, {
      projectSlug: this.projectSlug,
      states: stateNames,
      first: 250,
    });
    return data.issues.nodes.map(normalizeNode);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>> {
    if (issueIds.length === 0) return new Map();
    const data = await this.gql<{
      issues: { nodes: Array<{ id: string; state: { name: string } | null }> };
    }>(STATES_BY_IDS_QUERY, { ids: issueIds });
    const out = new Map<string, string>();
    for (const n of data.issues.nodes) {
      if (n?.id && n.state?.name) out.set(n.id, n.state.name);
    }
    return out;
  }

  /**
   * v1.2 — resolve a human-typed identifier (`ENG-123`) to an Issue. Returns
   * `null` when no issue matches so the HTTP layer can hand the macOS Link
   * sheet a clean 400 with `linear_unknown_identifier`.
   */
  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const data = await this.gql<{ issues: { nodes: LinearIssueNode[] } }>(
      ISSUE_BY_IDENTIFIER_QUERY,
      { identifier },
    );
    const nodes = data.issues?.nodes ?? [];
    if (nodes.length === 0) return null;
    const node = nodes[0];
    return node ? normalizeNode(node) : null;
  }

  /**
   * v1.2 reverse-sync support. Calls Linear's `issueUpdate` mutation with a
   * pre-resolved state id. When `success === false` we throw
   * `linear_state_not_found` so the caller can tell the difference between
   * "wrong state id" and a network blip.
   */
  async setIssueState(issueId: string, stateId: string): Promise<void> {
    const data = await this.gql<{
      issueUpdate: { success: boolean; issue: { id: string } | null };
    }>(SET_ISSUE_STATE_MUTATION, { issueId, stateId });
    if (!data.issueUpdate?.success) {
      throw new TrackerError(
        'linear_state_not_found',
        `Linear issueUpdate did not succeed for issue=${issueId} state=${stateId}`,
      );
    }
  }

  /**
   * v1.2 forward-sync support. Posts a Markdown comment to the linked issue.
   * Wraps a failed `commentCreate.success` as `linear_comment_failed` so the
   * comment syncer can swallow it and try again on the next tick.
   */
  async addIssueComment(issueId: string, body: string): Promise<{ id: string }> {
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(ADD_ISSUE_COMMENT_MUTATION, { issueId, body });
    if (!data.commentCreate?.success || !data.commentCreate.comment?.id) {
      throw new TrackerError(
        'linear_comment_failed',
        `Linear commentCreate did not succeed for issue=${issueId}`,
      );
    }
    return { id: data.commentCreate.comment.id };
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let resp: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    try {
      try {
        resp = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: this.apiKey,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new TrackerError(
          'linear_api_request',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!resp.ok) {
        let body = '';
        try {
          body = await resp.text();
        } catch {
          // ignore
        }
        throw new TrackerError(
          'linear_api_status',
          `Linear HTTP ${resp.status}: ${body.slice(0, 200) || resp.statusText}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = await resp.json();
      } catch (err) {
        throw new TrackerError(
          'linear_unknown_payload',
          `Linear returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new TrackerError('linear_unknown_payload', 'Linear returned a non-object body');
      }
      const obj = parsed as { data?: unknown; errors?: unknown };
      if (Array.isArray(obj.errors) && obj.errors.length > 0) {
        throw new TrackerError(
          'linear_graphql_errors',
          `Linear GraphQL errors: ${JSON.stringify(obj.errors).slice(0, 300)}`,
        );
      }
      if (!obj.data || typeof obj.data !== 'object') {
        throw new TrackerError('linear_unknown_payload', 'Linear response missing data');
      }
      return obj.data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface CandidatesPayload {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: LinearIssueNode[];
  };
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  url?: string | null;
  branchName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  labels?: { nodes?: Array<{ name?: string | null }> } | null;
  state?: { name?: string | null } | null;
  inverseRelations?: {
    nodes?: Array<{
      issue?: {
        id?: string | null;
        identifier?: string | null;
        state?: { name?: string | null } | null;
      } | null;
    }>;
  } | null;
}

function normalizeNode(node: LinearIssueNode): Issue {
  const labels: string[] = [];
  for (const l of node.labels?.nodes ?? []) {
    if (l?.name) labels.push(l.name.toLowerCase());
  }
  const blocked_by: BlockerRef[] = [];
  for (const r of node.inverseRelations?.nodes ?? []) {
    blocked_by.push({
      id: r.issue?.id ?? null,
      identifier: r.issue?.identifier ?? null,
      state: r.issue?.state?.name ?? null,
    });
  }
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? '',
    description: node.description ?? null,
    priority:
      typeof node.priority === 'number' && Number.isInteger(node.priority) ? node.priority : null,
    state: node.state?.name ?? '',
    branch_name: node.branchName ?? null,
    url: node.url ?? null,
    labels,
    blocked_by,
    created_at: node.createdAt ?? null,
    updated_at: node.updatedAt ?? null,
  };
}
