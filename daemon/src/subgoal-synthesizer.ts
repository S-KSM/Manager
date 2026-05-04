import type { ManagerEvent } from './event-store.js';
import { EventStore } from './event-store.js';
import {
  type LLMProvider,
  type LLMProviderName,
  LLMConfigError,
  LLMUnreachableError,
  getProvider as defaultGetProvider,
} from './llm/index.js';
import { readEnvWithLegacy } from './config.js';
import type { WorkstreamRegistry } from './workstream.js';

/**
 * Background ticker that turns long stretches of un-narrated `tool_use` events
 * into synthesized `subgoal_push` events so the macOS timeline reads as a
 * story instead of a list of bash/Edit/Read calls.
 *
 * Detection: walk events chronologically; collect runs of consecutive tool_use
 * (anything else — decision, subgoal_push, blocked, …, including a
 * previously-synthesized subgoal_push — breaks the run). A run of >=
 * `runThreshold` tool calls becomes one synthesized sub-goal.
 *
 * Idempotency across restart: each run yields a deterministic
 * `synth_anchor` ("<firstId>..<lastId>"). On every tick we read the existing
 * event log and skip windows whose anchor is already represented by a
 * subgoal_push event with `payload.source === "synthesized"`. So even if the
 * daemon restarts, the same window is never summarized twice.
 *
 * On any LLM error (unreachable, config, request) we silently skip — this is
 * a best-effort enrichment; the human can still read raw tool_use rows
 * (collapsed into the actions pill) on the client.
 */
export interface SubgoalSynthesizerOptions {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  getProvider?: (name: LLMProviderName) => LLMProvider;
  /** Override default tick interval (ms). */
  tickIntervalMs?: number;
  /** Override default LLM provider name. */
  providerName?: LLMProviderName;
  /** Override default model. */
  model?: string;
  /** Minimum tool_use events in a row before we summarize. Default 8. */
  runThreshold?: number;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_OLLAMA_MODEL = 'qwen3:4b';
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_RUN_THRESHOLD = 8;
const SUBGOAL_MAX_CHARS = 100;

const SYSTEM_PROMPT = [
  'You summarize what an AI coding agent was doing during a stretch of tool calls.',
  'Reply with EXACTLY ONE present-progressive sentence, ≤100 chars.',
  'Focus on the goal, not the tools. Examples:',
  '  "Tracing the request through the auth middleware to find the bug."',
  '  "Wiring the new pricing field into the checkout component."',
  '  "Reading the migration history before changing the schema."',
  'Do NOT wrap in quotes. Do NOT add a preamble. Output the sentence only.',
].join('\n');

/** A run of consecutive tool_use events ready for summarization. */
interface ToolRun {
  events: ManagerEvent[];
  anchor: string;
}

export class SubgoalSynthesizer {
  private readonly registry: WorkstreamRegistry;
  private readonly eventStore: EventStore;
  private readonly getProvider: (name: LLMProviderName) => LLMProvider;
  private readonly tickIntervalMs: number;
  private readonly providerName: LLMProviderName;
  private readonly model: string;
  private readonly runThreshold: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: SubgoalSynthesizerOptions) {
    this.registry = opts.registry;
    this.eventStore = opts.eventStore;
    this.getProvider = opts.getProvider ?? defaultGetProvider;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.providerName = opts.providerName ?? resolveDefaultProvider();
    this.model = opts.model ?? resolveDefaultModel(this.providerName);
    this.runThreshold = opts.runThreshold ?? DEFAULT_RUN_THRESHOLD;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Visible for tests + the start-of-tick loop. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const ws of this.registry.list()) {
        if (ws.status === 'retired') continue;
        await this.synthesizeForWorkstream(ws.id);
      }
    } finally {
      this.running = false;
    }
  }

  private async synthesizeForWorkstream(workstreamId: string): Promise<void> {
    let events: ManagerEvent[];
    try {
      const result = await this.eventStore.readEvents(workstreamId);
      events = result.events;
    } catch {
      return;
    }
    if (events.length === 0) return;

    const existingAnchors = collectExistingAnchors(events);
    const runs = detectToolRuns(events, this.runThreshold);
    for (const run of runs) {
      if (existingAnchors.has(run.anchor)) continue;
      const goal = await this.summarize(run);
      if (goal === null) return; // bail on first LLM failure to avoid spamming.
      const synthEv = makeSynthEvent(workstreamId, run, goal);
      try {
        await this.eventStore.appendEvent(workstreamId, synthEv);
        existingAnchors.add(run.anchor);
      } catch {
        return;
      }
    }
  }

  /** Visible for tests. Returns null on any LLM error. */
  async summarize(run: ToolRun): Promise<string | null> {
    const lines = run.events.map(formatToolLine).filter((l) => l !== null);
    if (lines.length === 0) return null;
    const userPrompt = `Recent tool calls:\n${lines.join('\n')}`;
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
    return cleanGoal(raw);
  }
}

/**
 * Collect synth_anchor strings already represented in the event log so we
 * don't double-write the same window across restarts.
 */
function collectExistingAnchors(events: ManagerEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'subgoal_push') continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    if (payload['source'] !== 'synthesized') continue;
    const anchor = payload['synth_anchor'];
    if (typeof anchor === 'string' && anchor.length > 0) seen.add(anchor);
  }
  return seen;
}

/**
 * Find every run of >= threshold consecutive tool_use events. Any
 * non-tool_use event breaks a run (including previously-synthesized
 * subgoal_push events — which is what we want, so a synthesized sub-goal
 * splits the next tick's runs).
 *
 * `tool_use` events come in pre/post pairs from the hook layer; we count
 * only post-tool-use (the mirror with results) so the threshold reflects
 * actual completed actions, not noise.
 */
export function detectToolRuns(events: ManagerEvent[], threshold: number): ToolRun[] {
  const runs: ToolRun[] = [];
  let current: ManagerEvent[] = [];
  const flush = () => {
    const filtered = current.filter(isPostToolUse);
    if (filtered.length >= threshold) {
      const first = filtered[0]!;
      const last = filtered[filtered.length - 1]!;
      runs.push({
        events: filtered,
        anchor: `${first.id ?? '?'}..${last.id ?? '?'}`,
      });
    }
    current = [];
  };
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      current.push(ev);
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

function isPostToolUse(ev: ManagerEvent): boolean {
  if (ev.type !== 'tool_use') return false;
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const hook = typeof payload['hook'] === 'string' ? (payload['hook'] as string) : '';
  // Older fixtures use `phase` instead of `hook`; treat both the same.
  const phase = typeof payload['phase'] === 'string' ? (payload['phase'] as string) : '';
  // Default to "post" when neither is present (e.g. v0 fixtures with bare tool name).
  if (!hook && !phase) return true;
  return hook === 'post-tool-use' || phase === 'post-tool-use' || phase === 'post';
}

function formatToolLine(ev: ManagerEvent): string | null {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const tool =
    stringOr(payload['tool_name'], '') || stringOr((payload as { tool?: unknown }).tool, '');
  if (!tool) return null;
  const input = (payload['tool_input'] ?? {}) as Record<string, unknown>;
  const detail = formatToolDetail(tool, input);
  const ts = typeof ev.ts === 'string' ? ev.ts.slice(11, 16) : '?';
  return detail ? `${ts} ${tool}: ${detail}` : `${ts} ${tool}`;
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
    default:
      return '';
  }
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * Build the synthesized event. We place its ts 1ms after the last tool_use
 * in the run so it sorts naturally between the run and the next event.
 * The id embeds the anchor so synthesized events are recognizable by id
 * alone, on top of the source/synth_anchor payload markers.
 */
function makeSynthEvent(workstreamId: string, run: ToolRun, goal: string): ManagerEvent {
  const last = run.events[run.events.length - 1]!;
  const lastTs = typeof last.ts === 'string' ? last.ts : new Date().toISOString();
  const ts = bumpTs(lastTs);
  return {
    ts,
    workstream_id: workstreamId,
    type: 'subgoal_push',
    id: `synth-${run.anchor}`,
    payload: {
      goal,
      source: 'synthesized',
      synth_anchor: run.anchor,
    },
  };
}

function bumpTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  d.setMilliseconds(d.getMilliseconds() + 1);
  return d.toISOString();
}

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

/** Strip <think> blocks, take first line, drop wrapping quotes, cap length. */
export function cleanGoal(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const firstLine =
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  s = firstLine;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.length > SUBGOAL_MAX_CHARS) {
    s = `${s.slice(0, SUBGOAL_MAX_CHARS - 1)}…`;
  }
  return s;
}
