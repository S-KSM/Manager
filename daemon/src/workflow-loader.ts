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
 *     kind: linear | mock
 *     project_slug: foo            # Linear only
 *     api_key: $LINEAR_API_KEY     # Linear only
 *     endpoint: https://api.linear.app/graphql
 *     active_states: [Todo, In Progress]
 *     terminal_states: [Done, Closed, Cancelled]
 *     source: /path/to/file.json   # Mock only
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
 *     runtime: claude-code        # Dispatch (replaces Symphony's `codex.command`)
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
  kind: 'linear' | 'mock';
  endpoint?: string;
  /** Resolved (env var indirection already applied). Empty string means missing. */
  api_key?: string;
  project_slug?: string;
  active_states: string[];
  terminal_states: string[];
  /** mock only — absolute path resolved relative to workflow dir. */
  source?: string;
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
  runtime: 'claude-code' | 'codex';
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
  const kind = kindRaw === 'linear' || kindRaw === 'mock' ? kindRaw : 'mock';
  return {
    kind,
    endpoint: strOr(r['endpoint'], kind === 'linear' ? DEFAULT_LINEAR_ENDPOINT : ''),
    api_key: resolveEnvIndirection(strOr(r['api_key'], '')),
    project_slug: strOr(r['project_slug'], '') || undefined,
    active_states: strArr(r['active_states'], DEFAULT_ACTIVE_STATES),
    terminal_states: strArr(r['terminal_states'], DEFAULT_TERMINAL_STATES),
    source: r['source'] ? resolveRelative(strOr(r['source'], ''), workflowDir) : undefined,
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
  const runtime = runtimeRaw === 'codex' ? 'codex' : 'claude-code';
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
