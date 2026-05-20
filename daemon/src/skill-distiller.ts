import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';
import type { EventStore, ManagerEvent } from './event-store.js';
import type { HandbookStore } from './handbook-store.js';
import {
  type LLMProvider,
  type LLMProviderName,
  type ProviderOverrides,
  LLMConfigError,
  LLMUnreachableError,
  getProvider as defaultGetProvider,
} from './llm/index.js';
import type { SettingsStore } from './settings-store.js';
import type { SkillProposalsStore } from './skill-proposals.js';
import type { WorkstreamRegistry } from './workstream.js';

export interface SkillDistillerOptions {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  handbookStore: HandbookStore;
  skillProposalsStore: SkillProposalsStore;
  settings?: SettingsStore;
  getProvider?: (name: LLMProviderName, overrides?: ProviderOverrides) => LLMProvider;
  /** Override default tick interval (ms). */
  tickIntervalMs?: number;
  /** Override default LLM provider name. */
  providerName?: LLMProviderName;
  /** Override default model. */
  model?: string;
  /**
   * A session is considered "worth distilling" iff it has at least this many
   * decision events OR at least `subgoalThreshold` subgoal_push events between
   * its session_start and session_end. Default decisionThreshold=1.
   */
  decisionThreshold?: number;
  subgoalThreshold?: number;
  /** Override default dbPath (for tests). Defaults to getConfig().dbPath. */
  dbPath?: string;
}

const DEFAULT_TICK_MS = 120_000;
const DEFAULT_OLLAMA_MODEL = 'qwen3:4b';
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_DECISION_THRESHOLD = 1;
const DEFAULT_SUBGOAL_THRESHOLD = 3;
const TITLE_MAX_CHARS = 80;
const BODY_MAX_CHARS = 2000;
const DIGEST_DECISION_CAP = 50;
const DIGEST_SUBGOAL_CAP = 50;

const SYSTEM_PROMPT = [
  'You review one AI coding agent session and decide whether it produced a',
  'reusable pattern worth promoting to a team handbook used by every agent.',
  '',
  'Be conservative. Most sessions produce NO new skill — only propose when the',
  'session reveals a transferable how-to that is not obviously already in the',
  'existing handbook titles.',
  '',
  'Reply with STRICT JSON, no markdown fences, no preamble. Shape:',
  '  {"propose": false}',
  '  {"propose": true, "title": "≤80 chars", "body": "Markdown ≤2KB: what, when to use, why"}',
  '',
  'Rules:',
  '- Output a single JSON object on one logical document, no commentary.',
  '- title must be a noun phrase, not a sentence.',
  '- body should be self-contained: a future agent reading only this entry',
  '  should know what the pattern is and when to apply it.',
  '- If the session is exploratory, debugging, or routine refactoring with no',
  '  reusable insight, return {"propose": false}.',
].join('\n');

/**
 * Lazy SQLite-backed bookkeeping: which sessions we have already evaluated.
 * Separate table from `sessions` so we don't lock that schema for an
 * orthogonal feature.
 */
export class SkillDistillerSeenStore {
  private readonly db: DatabaseType;

  constructor(dbPath?: string) {
    const path = dbPath ?? getConfig().dbPath;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_distiller_seen (
        session_id    TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL,
        distilled_at  TEXT NOT NULL,
        outcome       TEXT NOT NULL
      );
    `);
  }

  has(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM skill_distiller_seen WHERE session_id = ?')
      .get(sessionId);
    return row !== undefined;
  }

  mark(sessionId: string, workstreamId: string, outcome: SeenOutcome): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO skill_distiller_seen (session_id, workstream_id, distilled_at, outcome) VALUES (?, ?, ?, ?)',
      )
      .run(sessionId, workstreamId, new Date().toISOString(), outcome);
  }

  close(): void {
    this.db.close();
  }
}

export type SeenOutcome =
  | 'below_threshold'
  | 'proposed'
  | 'no_proposal'
  | 'dup_title'
  | 'invalid_response';

/**
 * SkillDistiller — periodically scans for closed sessions, asks the LLM
 * whether each one produced a reusable skill, and inserts the survivors into
 * `skill_proposals` for the human dispatcher to promote. Sibling of
 * `SubgoalSynthesizer` and `Headliner`: same provider seam, same settings
 * hot-reload, same soft-fail-on-LLM-down semantics.
 */
export class SkillDistiller {
  private readonly registry: WorkstreamRegistry;
  private readonly eventStore: EventStore;
  private readonly handbookStore: HandbookStore;
  private readonly proposals: SkillProposalsStore;
  private readonly settings: SettingsStore | undefined;
  private readonly getProvider: (
    name: LLMProviderName,
    overrides?: ProviderOverrides,
  ) => LLMProvider;
  private readonly tickIntervalMs: number;
  private readonly providerName: LLMProviderName;
  private readonly model: string;
  private readonly decisionThreshold: number;
  private readonly subgoalThreshold: number;
  private readonly seen: SkillDistillerSeenStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: SkillDistillerOptions) {
    this.registry = opts.registry;
    this.eventStore = opts.eventStore;
    this.handbookStore = opts.handbookStore;
    this.proposals = opts.skillProposalsStore;
    this.settings = opts.settings;
    this.getProvider = opts.getProvider ?? defaultGetProvider;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.providerName = opts.providerName ?? resolveDefaultProvider();
    this.model = opts.model ?? resolveDefaultModel(this.providerName);
    this.decisionThreshold = opts.decisionThreshold ?? DEFAULT_DECISION_THRESHOLD;
    this.subgoalThreshold = opts.subgoalThreshold ?? DEFAULT_SUBGOAL_THRESHOLD;
    this.seen = new SkillDistillerSeenStore(opts.dbPath);
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
    this.seen.close();
  }

  /** Visible for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const handbookTitles = parseHandbookTitles(await this.handbookStore.read());
      for (const ws of this.registry.list()) {
        if (ws.status === 'retired') continue;
        await this.distillForWorkstream(ws.id, handbookTitles);
      }
    } finally {
      this.running = false;
    }
  }

  private async distillForWorkstream(
    workstreamId: string,
    handbookTitles: Set<string>,
  ): Promise<void> {
    let events: ManagerEvent[];
    try {
      const result = await this.eventStore.readEvents(workstreamId);
      events = result.events;
    } catch {
      return;
    }
    if (events.length === 0) return;

    const sessions = groupBySession(events);
    for (const session of sessions) {
      if (!session.ended) continue;
      if (this.seen.has(session.sessionId)) continue;
      if (!meetsThreshold(session, this.decisionThreshold, this.subgoalThreshold)) {
        this.seen.mark(session.sessionId, workstreamId, 'below_threshold');
        continue;
      }
      const digest = buildDigest(session);
      const result = await this.askLLM(digest, [...handbookTitles]);
      if (result === null) {
        // LLM unreachable / parse failure → DO NOT mark seen. Retry next tick.
        return;
      }
      if (!result.propose) {
        this.seen.mark(session.sessionId, workstreamId, 'no_proposal');
        continue;
      }
      const title = sanitizeTitle(result.title);
      const body = sanitizeBody(result.body);
      if (title === null || body === null) {
        this.seen.mark(session.sessionId, workstreamId, 'invalid_response');
        continue;
      }
      if (handbookTitles.has(title.toLowerCase())) {
        this.seen.mark(session.sessionId, workstreamId, 'dup_title');
        continue;
      }
      const proposeArgs: Parameters<SkillProposalsStore['propose']>[0] = {
        workstream_id: workstreamId,
        title,
        body,
      };
      if (session.lastDecisionId) {
        proposeArgs.source_decision_id = session.lastDecisionId;
      }
      const proposal = this.proposals.propose(proposeArgs);
      const event: ManagerEvent = {
        ts: proposal.proposed_at,
        workstream_id: workstreamId,
        session_id: session.sessionId,
        type: 'skill_proposed',
        id: `sp_${randomUUID().slice(0, 8)}`,
        payload: {
          proposal_id: proposal.id,
          title: proposal.title,
          source: 'skill_distiller',
        },
      };
      try {
        await this.eventStore.appendEvent(workstreamId, event);
      } catch {
        // Event append failed but the proposal row exists — still mark seen so
        // we don't double-propose. Worst case: dispatcher sees a proposal with
        // no matching timeline event.
      }
      handbookTitles.add(title.toLowerCase());
      this.seen.mark(session.sessionId, workstreamId, 'proposed');
    }
  }

  /** Visible for tests. Returns null on LLM error or unparseable response. */
  async askLLM(digest: string, handbookTitles: string[]): Promise<LLMResult | null> {
    const providerName = this.settings?.getResolvedProvider() ?? this.providerName;
    const model = this.settings?.getResolvedModel(providerName) ?? this.model;
    const overrides: ProviderOverrides | undefined = this.settings
      ? {
          ...(this.settings.getResolvedAnthropicApiKey() !== undefined
            ? { anthropicApiKey: this.settings.getResolvedAnthropicApiKey() as string }
            : {}),
          ollamaUrl: this.settings.getResolvedOllamaUrl(),
        }
      : undefined;

    const titlesBlock =
      handbookTitles.length > 0
        ? `Existing handbook titles (do not duplicate):\n${handbookTitles.map((t) => `- ${t}`).join('\n')}`
        : 'Existing handbook titles: (none)';
    const userPrompt = `${titlesBlock}\n\nSession digest:\n${digest}`;

    let raw: string;
    try {
      const llm = this.getProvider(providerName, overrides);
      raw = await llm.generate({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        model,
        max_tokens: 800,
      });
    } catch (err) {
      if (err instanceof LLMUnreachableError || err instanceof LLMConfigError) {
        return null;
      }
      return null;
    }
    return parseLLMResponse(raw);
  }
}

// ---- helpers ---------------------------------------------------------------

interface SessionBundle {
  sessionId: string;
  ended: boolean;
  decisions: ManagerEvent[];
  subgoals: ManagerEvent[];
  lastDecisionId?: string;
}

export function groupBySession(events: ManagerEvent[]): SessionBundle[] {
  const map = new Map<string, SessionBundle>();
  const ensure = (sid: string): SessionBundle => {
    let b = map.get(sid);
    if (!b) {
      b = { sessionId: sid, ended: false, decisions: [], subgoals: [] };
      map.set(sid, b);
    }
    return b;
  };
  for (const ev of events) {
    const sid = ev.session_id;
    if (!sid) continue;
    const b = ensure(sid);
    if (ev.type === 'session_end') b.ended = true;
    if (ev.type === 'decision') {
      b.decisions.push(ev);
      if (ev.id) b.lastDecisionId = ev.id;
    }
    if (ev.type === 'subgoal_push') b.subgoals.push(ev);
  }
  return [...map.values()];
}

export function meetsThreshold(
  s: SessionBundle,
  decisionThreshold: number,
  subgoalThreshold: number,
): boolean {
  if (s.decisions.length >= decisionThreshold) return true;
  if (s.subgoals.length >= subgoalThreshold) return true;
  return false;
}

export function buildDigest(s: SessionBundle): string {
  const parts: string[] = [];
  if (s.decisions.length > 0) {
    parts.push('Decisions:');
    const slice = s.decisions.slice(-DIGEST_DECISION_CAP);
    for (const ev of slice) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const choice = typeof p['choice'] === 'string' ? p['choice'] : '?';
      const rationale = typeof p['rationale'] === 'string' ? p['rationale'] : '';
      parts.push(`- ${choice}${rationale ? ` — ${rationale}` : ''}`);
    }
  }
  if (s.subgoals.length > 0) {
    parts.push('');
    parts.push('Subgoals:');
    const slice = s.subgoals.slice(-DIGEST_SUBGOAL_CAP);
    for (const ev of slice) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const goal = typeof p['goal'] === 'string' ? p['goal'] : '?';
      parts.push(`- ${goal}`);
    }
  }
  return parts.join('\n');
}

export function parseHandbookTitles(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const line of markdown.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.add(m[1]!.toLowerCase());
  }
  return out;
}

export interface LLMResult {
  propose: boolean;
  title?: string;
  body?: string;
}

export function parseLLMResponse(raw: string): LLMResult | null {
  let text = raw.trim();
  // Strip code fences if the model wrapped JSON in ```json ... ```.
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text);
  if (fence) text = fence[1]!.trim();
  // Some models emit a preamble; extract the first {...} block.
  if (!text.startsWith('{')) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    text = m[0];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['propose'] !== 'boolean') return null;
  const out: LLMResult = { propose: obj['propose'] };
  if (typeof obj['title'] === 'string') out.title = obj['title'];
  if (typeof obj['body'] === 'string') out.body = obj['body'];
  return out;
}

function sanitizeTitle(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t.length === 0) return null;
  if (t.length > TITLE_MAX_CHARS) return null;
  return t;
}

function sanitizeBody(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const b = raw.trim();
  if (b.length === 0) return null;
  if (b.length > BODY_MAX_CHARS) return null;
  return b;
}

function resolveDefaultProvider(): LLMProviderName {
  const env = process.env['DISPATCH_LLM_PROVIDER'];
  if (env === 'claude' || env === 'ollama') return env;
  return 'ollama';
}

function resolveDefaultModel(provider: LLMProviderName): string {
  if (provider === 'claude') {
    return process.env['DISPATCH_LLM_MODEL'] ?? DEFAULT_CLAUDE_MODEL;
  }
  return process.env['DISPATCH_LLM_MODEL'] ?? DEFAULT_OLLAMA_MODEL;
}
