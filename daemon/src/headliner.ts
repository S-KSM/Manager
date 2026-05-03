import type { ManagerEvent } from './event-store.js';
import { EventStore } from './event-store.js';
import {
  type LLMProvider,
  type LLMProviderName,
  LLMConfigError,
  LLMUnreachableError,
  getProvider as defaultGetProvider,
} from './llm/index.js';
import { HeadlineStore } from './headline-store.js';
import { readEnvWithLegacy } from './config.js';
import type { WorkstreamRegistry } from './workstream.js';

/**
 * Background ticker that regenerates a one-sentence "what's the agent doing?"
 * summary for every active workstream by feeding recent events to a small LLM.
 *
 * Cadence: every `tickIntervalMs` (default 30s) we walk the registry and, for
 * each non-retired workstream, decide whether to regenerate:
 *  - Never regenerate if event count hasn't grown since last summary.
 *  - Otherwise regenerate (subject to a minimum of `minNewEventsToRefresh`
 *    new events to avoid spending tokens on every single tool call).
 *
 * On any LLM error (unreachable, config, request) we silently skip — the
 * client falls back to the deterministic `latest_activity` projection. We do
 * NOT log these per-tick to avoid spamming when the user has no LLM set up.
 */
export interface HeadlinerOptions {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  store: HeadlineStore;
  getProvider?: (name: LLMProviderName) => LLMProvider;
  /** Override default tick interval (ms). */
  tickIntervalMs?: number;
  /** Override default LLM provider name. */
  providerName?: LLMProviderName;
  /** Override default model. */
  model?: string;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_OLLAMA_MODEL = 'qwen3:4b';
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MIN_NEW_EVENTS_TO_REFRESH = 3;
const RECENT_EVENTS_WINDOW = 25;
const HEADLINE_MAX_CHARS = 100;

const SYSTEM_PROMPT = [
  'You summarize what an AI coding agent is currently doing.',
  'Reply with EXACTLY ONE sentence, present-tense, ≤100 chars.',
  'Focus on the goal/feature, not the tool. Examples:',
  '  "Refactoring auth middleware to use JWT."',
  '  "Debugging timeout in payment webhook."',
  '  "Reading the React component tree to plan a state migration."',
  'Do NOT wrap in quotes. Do NOT add a preamble. Output the sentence only.',
].join('\n');

export class Headliner {
  private readonly registry: WorkstreamRegistry;
  private readonly eventStore: EventStore;
  private readonly store: HeadlineStore;
  private readonly getProvider: (name: LLMProviderName) => LLMProvider;
  private readonly tickIntervalMs: number;
  private readonly providerName: LLMProviderName;
  private readonly model: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: HeadlinerOptions) {
    this.registry = opts.registry;
    this.eventStore = opts.eventStore;
    this.store = opts.store;
    this.getProvider = opts.getProvider ?? defaultGetProvider;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.providerName = opts.providerName ?? resolveDefaultProvider();
    this.model = opts.model ?? resolveDefaultModel(this.providerName);
  }

  start(): void {
    if (this.timer) return;
    // Kick once immediately so a fresh daemon doesn't have to wait 30s.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests + the start-of-tick loop. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const ws of this.registry.list()) {
        if (ws.status === 'retired') continue;
        await this.regenerateIfNeeded(ws.id);
      }
    } finally {
      this.running = false;
    }
  }

  private async regenerateIfNeeded(workstreamId: string): Promise<void> {
    let events: ManagerEvent[];
    try {
      const result = await this.eventStore.readEvents(workstreamId);
      events = result.events;
    } catch {
      return;
    }
    if (events.length === 0) return;
    const prior = this.store.get(workstreamId);
    if (prior !== undefined) {
      const delta = events.length - prior.lastEventCount;
      if (delta < MIN_NEW_EVENTS_TO_REFRESH) return;
    }
    const text = await this.summarize(workstreamId, events);
    if (text === null) return;
    this.store.set(workstreamId, {
      text,
      generatedAt: new Date().toISOString(),
      lastEventCount: events.length,
    });
  }

  /** Visible for tests. Returns null on any LLM error. */
  async summarize(workstreamId: string, events: ManagerEvent[]): Promise<string | null> {
    const recent = events.slice(-RECENT_EVENTS_WINDOW);
    const lines = recent.map(formatEventLine).filter((l) => l !== null);
    if (lines.length === 0) return null;
    const userPrompt = `Recent activity for workstream "${workstreamId}":\n${lines.join('\n')}`;

    let raw: string;
    try {
      const llm = this.getProvider(this.providerName);
      raw = await llm.generate({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        model: this.model,
        max_tokens: 80,
      });
    } catch (err) {
      if (err instanceof LLMUnreachableError || err instanceof LLMConfigError) {
        return null;
      }
      return null;
    }
    return cleanHeadline(raw);
  }
}

/**
 * Pick a default provider at construction time:
 *  1. `DISPATCH_HEADLINE_PROVIDER` env override.
 *  2. ollama (assume local llama-style server is available — falls through
 *     silently if not).
 */
function resolveDefaultProvider(): LLMProviderName {
  const env = readEnvWithLegacy('DISPATCH_HEADLINE_PROVIDER', 'MANAGER_HEADLINE_PROVIDER');
  if (env === 'claude' || env === 'ollama') return env;
  return 'ollama';
}

function resolveDefaultModel(provider: LLMProviderName): string {
  const env = readEnvWithLegacy('DISPATCH_HEADLINE_MODEL', 'MANAGER_HEADLINE_MODEL');
  if (env && env.length > 0) return env;
  return provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_OLLAMA_MODEL;
}

/**
 * One compact line per event for the LLM. Skips noise (session_start /
 * session_end / pre-tool-use mirrors). Returns null for events the model
 * doesn't need to see.
 */
function formatEventLine(ev: ManagerEvent): string | null {
  if (!ev || typeof ev !== 'object') return null;
  const ts = typeof ev.ts === 'string' ? ev.ts.slice(11, 16) : '?';
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case 'decision': {
      const choice = stringOr(payload['choice'], '');
      const rationale = stringOr(payload['rationale'], '');
      const head = choice ? `decision: ${choice}` : 'decision';
      return rationale ? `${ts} ${head} (${rationale.slice(0, 80)})` : `${ts} ${head}`;
    }
    case 'subgoal_push': {
      const goal = stringOr(payload['goal'], '');
      return goal ? `${ts} sub-goal start: ${goal}` : null;
    }
    case 'subgoal_pop': {
      const goal = stringOr(payload['goal'], '');
      return goal ? `${ts} sub-goal done: ${goal}` : `${ts} sub-goal done`;
    }
    case 'tool_use': {
      // Skip pre-tool-use for noise reasons — the post-* mirror has the same input.
      const hook = stringOr(payload['hook'], '');
      if (hook === 'pre-tool-use') return null;
      const tool =
        stringOr(payload['tool_name'], '') || stringOr((payload as { tool?: unknown }).tool, '');
      if (!tool) return null;
      const input = (payload['tool_input'] ?? {}) as Record<string, unknown>;
      const detail = formatToolDetail(tool, input);
      return detail ? `${ts} ${tool}: ${detail}` : `${ts} ${tool}`;
    }
    case 'blocked': {
      const reason = stringOr(payload['reason'], '');
      return reason ? `${ts} BLOCKED: ${reason}` : `${ts} BLOCKED`;
    }
    case 'memory_update': {
      const section = stringOr(payload['section'], '');
      return section ? `${ts} memory updated: ${section}` : null;
    }
    case 'intervention_delivered': {
      const kind = stringOr(payload['kind'], '');
      const message = stringOr(payload['message'], '');
      return message ? `${ts} intervention (${kind}): ${message}` : `${ts} intervention (${kind})`;
    }
    default:
      return null;
  }
}

function formatToolDetail(tool: string, input: Record<string, unknown>): string {
  const path = stringOr(input['file_path'], '') || stringOr(input['path'], '');
  const command = stringOr(input['command'], '');
  const pattern = stringOr(input['pattern'], '') || stringOr(input['query'], '');
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
      return path;
    case 'Bash':
      return command.length > 80 ? `${command.slice(0, 80)}…` : command;
    case 'Glob':
    case 'Grep':
      return pattern;
    case 'TodoWrite': {
      const todos = (input['todos'] ?? []) as unknown[];
      const active = Array.isArray(todos)
        ? todos.find(
            (t) => t && typeof t === 'object' && (t as { status?: unknown }).status === 'in_progress',
          )
        : undefined;
      const activeText =
        active && typeof active === 'object'
          ? stringOr(
              (active as { activeForm?: unknown }).activeForm,
              stringOr((active as { content?: unknown }).content, ''),
            )
          : '';
      return activeText
        ? `plan updated; active: ${activeText}`
        : `plan updated (${Array.isArray(todos) ? todos.length : 0} items)`;
    }
    default:
      return '';
  }
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * Trim model output to a single sentence, strip wrapping quotes/whitespace, cap
 * at HEADLINE_MAX_CHARS. Some models like to think out loud — we only keep the
 * first non-empty line.
 */
function cleanHeadline(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  // Strip <think>...</think> blocks some reasoning models emit.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Take the first non-empty line.
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  s = firstLine;
  // Strip wrapping quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Cap length.
  if (s.length > HEADLINE_MAX_CHARS) {
    s = `${s.slice(0, HEADLINE_MAX_CHARS - 1)}…`;
  }
  return s;
}
