import { type BlockerRef, type Issue, type Tracker, TrackerError } from './index.js';

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

const CANDIDATE_QUERY = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title description priority url branchName createdAt updatedAt
        labels { nodes { name } }
        state { name }
        inverseRelations(first: 50, filter: { type: { eq: "blocks" } }) {
          nodes {
            issue { id identifier state { name } }
          }
        }
      }
    }
  }
`;

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

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    // Hard cap pagination at 20 pages so a misconfigured project can't run away.
    for (let i = 0; i < 20; i++) {
      const data: CandidatesPayload = await this.gql<CandidatesPayload>(CANDIDATE_QUERY, {
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
      issue?: { id?: string | null; identifier?: string | null; state?: { name?: string | null } | null } | null;
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
    priority: typeof node.priority === 'number' && Number.isInteger(node.priority) ? node.priority : null,
    state: node.state?.name ?? '',
    branch_name: node.branchName ?? null,
    url: node.url ?? null,
    labels,
    blocked_by,
    created_at: node.createdAt ?? null,
    updated_at: node.updatedAt ?? null,
  };
}
