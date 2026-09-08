import { readFile, stat } from 'node:fs/promises';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

/**
 * WorkflowLoader — Symphony SPEC.md §5 (`WORKFLOW.md`) + §6.2 dynamic reload.
 *
 * `WORKFLOW.md` is OPTIONAL for Dispatch (unlike Symphony where it's REQUIRED
 * for dispatch). Without it, Dispatch stays in observation mode (today's
 * behavior). With it, the orchestrator subsystem boots and consumes its
 * config.
 *
 * Front matter shape (Symphony §5.3 + Dispatch adaptations):
 *
 *   tracker:
 *     kind: linear | mock | team-brain
 *     project_slug: foo            # Linear only
 *     api_key: $LINEAR_API_KEY     # Linear only
 *     endpoint: https://api.linear.app/graphql
 *     active_states: [Todo, In Progress]
 *     terminal_states: [Done, Closed, Cancelled]
 *     source: /path/to/file.json   # Mock only, or team-brain's plans/ dir root
 *     # v1.4.7 write-back (all optional, default off):
 *     claim_on_dispatch: true        # daemon writes back to the tracker
 *     assign_to_self: true           # default true when claim is on
 *     claim_state: "In Progress"     # null/omitted = leave state alone
 *     unassigned_only: true          # default true when claim is on
 *     stale_claim_ttl_ms: 600000     # v1.4.10.5: release self-claims older than 10min not in our running map
 *     # v1.4.12 Radar mirror (defaults off; opt in to surface unstarted Linear issues in the Kanban):
 *     mirror_to_radar: true
 *     mirror_states: [Backlog, Triage, Todo, In Progress]
 *     mirror_interval_ms: 60000
 *     mirror_max_age_days: 90
 *   polling:
 *     interval_ms: 30000
 *   workspace:
 *     root: ~/code/dispatch-workspaces
 *   hooks:
 *     after_create: |
 *       git clone --depth 1 ...
 *     before_run: |
 *       npm ci
 *     timeout_ms: 60000
 *   agent:
 *     runtime: claude-code        # claude-code | codex | claude-code-tmux
 *                                 # claude-code-tmux opens the workspace in a
 *                                 # tmux pane instead of a headless subprocess —
 *                                 # a human can attach mid-flight. Completion is
 *                                 # detected via the Stop hook's session_end
 *                                 # event, not process exit, so it requires the
 *                                 # daemon's hooks to be installed in the workspace.
 *     command: claude --print --output-format stream-json
 *     max_concurrent_agents: 5
 *     max_turns: 20
 *     turn_timeout_ms: 3600000
 */

export interface WorkflowDefinition {
  /** Absolute path resolved at load time. */
  source_path: string;
  config: WorkflowConfig;
  /** Markdown body after the front matter, trimmed. */
  prompt_template: string;
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
}

export interface TrackerConfig {
  kind: 'linear' | 'mock' | 'team-brain';
  endpoint?: string;
  /** Resolved (env var indirection already applied). Empty string means missing. */
  api_key?: string;
  project_slug?: string;
  active_states: string[];
  terminal_states: string[];
  /**
   * mock — absolute path to a JSON fixture, resolved relative to workflow dir.
   * team-brain — absolute path to the team-brain checkout's `plans/` dir root,
   * resolved relative to workflow dir.
   */
  source?: string;
  /**
   * v1.4.7 — write-back knobs. When `claim_on_dispatch` is false (default),
   * the orchestrator never calls into the tracker's claim/release methods —
   * Dispatch behaves exactly as it did in v1.4.6.
   */
  claim_on_dispatch: boolean;
  assign_to_self: boolean;
  /** Optional Linear state name moved into on claim. Null = leave state alone. */
  claim_state: string | null;
  /** When true, fetchCandidateIssues uses assigneeFilter='unassigned'. */
  unassigned_only: boolean;
  /**
   * v1.4.10.5 — Stale-claim sweep TTL in milliseconds. Default 0 (disabled).
   * When > 0 the orchestrator releases self-claimed active issues whose
   * `updatedAt` is older than this AND aren't currently in the running map
   * (i.e. left behind by a previous-instance daemon crash).
   */
  stale_claim_ttl_ms: number;
  /**
   * v1.4.12 — Linear → Radar mirror. When true a background ticker creates a
   * `status='backlog'` workstream + link for every issue in `mirror_states`
   * (default = active_states ∪ ['Backlog', 'Triage']) so upcoming work
   * surfaces in the Kanban without manual linking.
   */
  mirror_to_radar: boolean;
  /** v1.4.12 — States to mirror. Defaults to active_states ∪ ['Backlog', 'Triage']. */
  mirror_states: string[];
  /** v1.4.12 — Mirror tick cadence in ms. Default 60_000. */
  mirror_interval_ms: number;
  /**
   * v1.4.12 — Skip issues whose `created_at` is older than this many days.
   * Stops historical-burst on first run against a long-lived project. Null
   * (or 0) disables the cutoff.
   */
  mirror_max_age_days: number | null;
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  /** Resolved absolute path. */
  root: string;
}

export interface HooksConfig {
  after_create?: string | null;
  before_run?: string | null;
  after_run?: string | null;
  before_remove?: string | null;
  timeout_ms?: number;
}

export interface AgentConfig {
  runtime: 'claude-code' | 'codex' | 'claude-code-tmux';
  command: string;
  max_concurrent_agents: number;
  max_turns: number;
  turn_timeout_ms: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
  stall_timeout_ms: number;
}

const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'];
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'];
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 5 * 60 * 1_000;
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_AGENT_COMMAND = 'claude --print --output-format stream-json';

export type WorkflowErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map';

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

/**
 * Load `WORKFLOW.md` from `path`. Resolves env-backed values (`$VAR_NAME` →
 * env lookup, empty string == missing per Symphony §5.3.1). Throws
 * WorkflowError on parse failures so the caller can decide whether to abort
 * startup or skip dispatch this tick (Symphony §5.5).
 */
export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  const abs = resolve(path);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    throw new WorkflowError(
      'missing_workflow_file',
      `cannot read workflow file ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { front, body } = splitFrontMatter(raw);
  let parsedFront: unknown = {};
  if (front !== null) {
    try {
      parsedFront = yaml.load(front) ?? {};
    } catch (err) {
      throw new WorkflowError(
        'workflow_parse_error',
        `YAML parse error in ${abs}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (parsedFront === null || typeof parsedFront !== 'object' || Array.isArray(parsedFront)) {
    throw new WorkflowError(
      'workflow_front_matter_not_a_map',
      `front matter in ${abs} did not parse to a YAML map`,
    );
  }
  const config = coerceConfig(parsedFront as Record<string, unknown>, dirname(abs));
  return {
    source_path: abs,
    config,
    prompt_template: body.trim(),
  };
}

/** Split a markdown file with optional `---`-delimited YAML front matter. */
function splitFrontMatter(raw: string): { front: string | null; body: string } {
  if (!raw.startsWith('---')) return { front: null, body: raw };
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { front: null, body: raw };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { front: null, body: raw };
  const front = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n');
  return { front, body };
}

function coerceConfig(raw: Record<string, unknown>, workflowDir: string): WorkflowConfig {
  const tracker = coerceTracker(raw['tracker'], workflowDir);
  const polling = coercePolling(raw['polling']);
  const workspace = coerceWorkspace(raw['workspace'], workflowDir);
  const hooks = coerceHooks(raw['hooks']);
  const agent = coerceAgent(raw['agent']);
  return { tracker, polling, workspace, hooks, agent };
}

function coerceTracker(raw: unknown, workflowDir: string): TrackerConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kindRaw = strOr(r['kind'], 'mock');
  const kind: TrackerConfig['kind'] =
    kindRaw === 'linear' ? 'linear' : kindRaw === 'team-brain' ? 'team-brain' : 'mock';
  const claimOnDispatch = boolOr(r['claim_on_dispatch'], false);
  return {
    kind,
    endpoint: strOr(r['endpoint'], kind === 'linear' ? DEFAULT_LINEAR_ENDPOINT : ''),
    api_key: resolveEnvIndirection(strOr(r['api_key'], '')),
    project_slug: strOr(r['project_slug'], '') || undefined,
    active_states: strArr(r['active_states'], DEFAULT_ACTIVE_STATES),
    terminal_states: strArr(r['terminal_states'], DEFAULT_TERMINAL_STATES),
    source: r['source'] ? resolveRelative(strOr(r['source'], ''), workflowDir) : undefined,
    claim_on_dispatch: claimOnDispatch,
    // assign_to_self / unassigned_only default true ONLY when claim is on, so a
    // workflow that opts in by flipping one bit gets the safe defaults.
    assign_to_self: boolOr(r['assign_to_self'], claimOnDispatch),
    claim_state: strOrNull(r['claim_state']),
    unassigned_only: boolOr(r['unassigned_only'], claimOnDispatch),
    stale_claim_ttl_ms: numOr(r['stale_claim_ttl_ms'], 0),
    mirror_to_radar: boolOr(r['mirror_to_radar'], false),
    // Default mirror_states is computed in the cli (it needs active_states),
    // but if the user supplied an explicit list we honor it as-is.
    mirror_states: strArr(r['mirror_states'], []),
    mirror_interval_ms: numOr(r['mirror_interval_ms'], 60_000),
    mirror_max_age_days:
      typeof r['mirror_max_age_days'] === 'number' && Number.isFinite(r['mirror_max_age_days'])
        ? (r['mirror_max_age_days'] as number)
        : null,
  };
}

function coercePolling(raw: unknown): PollingConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ms = numOr(r['interval_ms'], DEFAULT_POLL_INTERVAL_MS);
  return { interval_ms: ms > 0 ? ms : DEFAULT_POLL_INTERVAL_MS };
}

function coerceWorkspace(raw: unknown, workflowDir: string): WorkspaceConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rootRaw = strOr(r['root'], '');
  const root = rootRaw ? resolveRelative(rootRaw, workflowDir) : '';
  return { root };
}

function coerceHooks(raw: unknown): HooksConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    after_create: strOrNull(r['after_create']),
    before_run: strOrNull(r['before_run']),
    after_run: strOrNull(r['after_run']),
    before_remove: strOrNull(r['before_remove']),
    timeout_ms: numOr(r['timeout_ms'], DEFAULT_HOOK_TIMEOUT_MS),
  };
}

function coerceAgent(raw: unknown): AgentConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const runtimeRaw = strOr(r['runtime'], 'claude-code');
  const runtime =
    runtimeRaw === 'codex'
      ? 'codex'
      : runtimeRaw === 'claude-code-tmux'
        ? 'claude-code-tmux'
        : 'claude-code';
  const byStateRaw = (r['max_concurrent_agents_by_state'] ?? {}) as Record<string, unknown>;
  const byState: Record<string, number> = {};
  if (byStateRaw && typeof byStateRaw === 'object') {
    for (const [k, v] of Object.entries(byStateRaw)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) byState[k.toLowerCase()] = v;
    }
  }
  return {
    runtime,
    command: strOr(r['command'], DEFAULT_AGENT_COMMAND),
    max_concurrent_agents: clampInt(r['max_concurrent_agents'], DEFAULT_MAX_CONCURRENT),
    max_turns: clampInt(r['max_turns'], DEFAULT_MAX_TURNS),
    turn_timeout_ms: clampInt(r['turn_timeout_ms'], DEFAULT_TURN_TIMEOUT_MS),
    max_retry_backoff_ms: clampInt(r['max_retry_backoff_ms'], DEFAULT_MAX_RETRY_BACKOFF_MS),
    max_concurrent_agents_by_state: byState,
    stall_timeout_ms: numOr(r['stall_timeout_ms'], DEFAULT_STALL_TIMEOUT_MS),
  };
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function strArr(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : fallback;
}
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function clampInt(v: unknown, fallback: number): number {
  const n = numOr(v, fallback);
  return n > 0 ? Math.floor(n) : fallback;
}

function resolveRelative(p: string, base: string): string {
  let r = p;
  if (r.startsWith('~')) r = r.replace(/^~/, homedir());
  if (isAbsolute(r)) return r;
  return resolve(base, r);
}

/** Symphony §5.3.1 — `$VAR_NAME` lookup; empty resolves to "" (treated as missing). */
function resolveEnvIndirection(v: string): string {
  if (!v.startsWith('$')) return v;
  const name = v.slice(1);
  return process.env[name] ?? '';
}

/**
 * Watch the workflow file and reload on change. Symphony §6.2 — never crash
 * on bad reload; keep the last known good config and let the caller decide.
 */
export function watchWorkflow(
  path: string,
  onChange: (next: WorkflowDefinition | WorkflowError) => void,
): { close: () => void } {
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void loadWorkflow(path)
        .then((wf) => onChange(wf))
        .catch((err: unknown) => {
          if (err instanceof WorkflowError) onChange(err);
        });
    }, 100);
  };
  try {
    watcher = fsWatch(path, () => fire());
  } catch {
    // fall through to no-watch (tests stub anyway)
  }
  // Backstop poll once a minute in case fs.watch misses the event.
  const poll = setInterval(async () => {
    try {
      await stat(path);
      fire();
    } catch {
      // ignore — file gone
    }
  }, 60_000);
  return {
    close: () => {
      if (watcher) watcher.close();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    },
  };
}
