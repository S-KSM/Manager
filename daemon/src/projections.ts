import type { ManagerEvent } from './event-store.js';

/**
 * Home-view projections derived from a workstream's event log.
 *
 * These five fields are documented in `docs/ARCHITECTURE.md` under
 * "Workstream" and feed the macOS app's home cards. The projection is a
 * pure function of the events array; the caller is responsible for I/O
 * (reading events) and for any caching. v1 will index these in SQLite;
 * for v0/v0.5 file sizes, recomputing on each request is fine.
 */
export interface WorkstreamProjections {
  current_subgoal: string | null;
  latest_confidence: number | null;
  needs_attention: boolean;
  /**
   * Latest TodoWrite tool_use's todo array, last write wins. `null` when no
   * `tool_use` event with `payload.tool_name === 'TodoWrite'` (or the legacy
   * `payload.tool === 'TodoWrite'`) has been seen yet. Permissive parse:
   * extra keys allowed, unknown statuses skipped, malformed items ignored.
   */
  todos: Todo[] | null;
  /**
   * One-line humanized summary of the most recent `tool_use` event, suitable
   * for a "Currently:" line in the workstream card. Truncated to 80 chars.
   * `null` when no `tool_use` event has ever fired for the workstream.
   *
   * This is a pure heuristic — fine if it's not perfect. The card prefers
   * `todos` (the agent's actual plan) when present; this is the fallback.
   */
  latest_activity: string | null;
  /**
   * "Has a Claude Code session running right now" — derived as: the most
   * recent `session_start` (by `ts`) is newer than the most recent
   * `session_end` (by `ts`). `false` when no `session_start` has ever been
   * emitted, or when the latest `session_end` is at-or-after the latest
   * `session_start`. Pure presentation signal — independent of the
   * workstream's lifecycle status (active / paused / retired). Drives the
   * macOS Radar's awake/asleep robot mascot.
   */
  live_session: boolean;
}

/** Mirrors Claude Code's TodoWrite item shape; permissive on extras. */
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

const ACTIVITY_LINE_MAX = 80;

/**
 * Compute home-view projections from a chronological event array.
 *
 * Tolerant of malformed events: any unexpected shape (missing payload,
 * wrong field types, etc.) is silently ignored rather than throwing.
 *
 * Rules:
 *
 * - `current_subgoal`: walk events in order, maintaining a stack of
 *   `payload.goal` strings. `subgoal_push` pushes; `subgoal_pop` pops.
 *   Returns the head of the stack at end-of-walk, or `null` if empty.
 *
 * - `latest_confidence`: the most-recent (by `ts`) numeric confidence
 *   from either a `confidence` event (`payload.value`) or a `decision`
 *   event (`payload.confidence`). Non-numeric values are ignored.
 *   `null` if neither event has occurred with a numeric value.
 *
 * - `needs_attention`: `true` iff there exists a `blocked` event with
 *   no later `session_end` for the same `session_id`. If the blocked
 *   event has no `session_id`, any later `session_end` (regardless of
 *   session) is treated as the resolver.
 *
 * - `todos`: latest `tool_use` event whose payload identifies the tool as
 *   `TodoWrite`. The todo array is read from `payload.tool_input.todos`
 *   (the Claude Code hook-payload shape), `payload.input.todos` (the
 *   official Anthropic API shape some agents may forward), or
 *   `payload.todos` as a last-ditch fallback. `null` if no TodoWrite
 *   call has been seen.
 *
 * - `latest_activity`: humanized one-liner derived from the most recent
 *   `tool_use` event, truncated to 80 chars. `null` if no `tool_use`
 *   has been seen.
 *
 * The events array is assumed to be in chronological/file order — the
 * order returned by `EventStore.readEvents`.
 */
export function projectFromEvents(events: ManagerEvent[]): WorkstreamProjections {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      current_subgoal: null,
      latest_confidence: null,
      needs_attention: false,
      todos: null,
      latest_activity: null,
      live_session: false,
    };
  }

  // current_subgoal: stack from subgoal_push / subgoal_pop in chronological order.
  const subgoalStack: string[] = [];

  // latest_confidence: track the latest (by ts) numeric confidence.
  let latestConfidence: number | null = null;
  let latestConfidenceTs: string | null = null;

  // needs_attention: track latest blocked event and latest session_end per session.
  let latestBlocked: ManagerEvent | null = null;
  const latestSessionEndBySession = new Map<string, string>();
  let latestSessionEndAny: string | null = null;

  // todos: latest TodoWrite tool_use's parsed todo array (last write wins).
  let latestTodos: Todo[] | null = null;
  let latestTodosTs: string | null = null;

  // latest_activity: humanized last tool_use string.
  let latestActivity: string | null = null;
  let latestActivityTs: string | null = null;

  // live_session: latest session_start vs. latest session_end. Compared as ISO
  // strings (lexicographic order matches chronological order for ISO-8601).
  let latestSessionStartTs: string | null = null;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const type = ev.type;
    const payload = ev.payload;
    const ts = typeof ev.ts === 'string' ? ev.ts : null;

    if (type === 'subgoal_push') {
      const goal =
        payload && typeof payload === 'object' ? (payload as { goal?: unknown }).goal : undefined;
      if (typeof goal === 'string' && goal.length > 0) {
        subgoalStack.push(goal);
      }
    } else if (type === 'subgoal_pop') {
      subgoalStack.pop();
    } else if (type === 'confidence') {
      const value =
        payload && typeof payload === 'object' ? (payload as { value?: unknown }).value : undefined;
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (latestConfidenceTs === null || (ts !== null && ts >= latestConfidenceTs)) {
          latestConfidence = value;
          latestConfidenceTs = ts;
        }
      }
    } else if (type === 'decision') {
      const confidence =
        payload && typeof payload === 'object'
          ? (payload as { confidence?: unknown }).confidence
          : undefined;
      if (typeof confidence === 'number' && Number.isFinite(confidence)) {
        if (latestConfidenceTs === null || (ts !== null && ts >= latestConfidenceTs)) {
          latestConfidence = confidence;
          latestConfidenceTs = ts;
        }
      }
    } else if (type === 'blocked') {
      // Track the latest blocked event by ts (fall back to occurrence order).
      if (
        latestBlocked === null ||
        (ts !== null && typeof latestBlocked.ts === 'string' && ts >= latestBlocked.ts)
      ) {
        latestBlocked = ev;
      }
    } else if (type === 'session_end') {
      if (ts !== null) {
        if (typeof ev.session_id === 'string' && ev.session_id.length > 0) {
          const prior = latestSessionEndBySession.get(ev.session_id);
          if (prior === undefined || ts >= prior) {
            latestSessionEndBySession.set(ev.session_id, ts);
          }
        }
        if (latestSessionEndAny === null || ts >= latestSessionEndAny) {
          latestSessionEndAny = ts;
        }
      }
    } else if (type === 'session_start') {
      if (ts !== null) {
        if (latestSessionStartTs === null || ts >= latestSessionStartTs) {
          latestSessionStartTs = ts;
        }
      }
    } else if (type === 'tool_use') {
      // Update humanized "Currently:" projection on every tool_use, not just
      // TodoWrite — most calls are Edit/Read/Bash etc.
      const summary = humanizeToolUse(payload);
      if (summary !== null) {
        if (latestActivityTs === null || (ts !== null && ts >= latestActivityTs)) {
          latestActivity = truncate(summary, ACTIVITY_LINE_MAX);
          latestActivityTs = ts;
        }
      }
      // TodoWrite gets its own special-case: parse the todo array.
      if (isTodoWritePayload(payload)) {
        const parsed = parseTodos(payload);
        if (parsed !== null) {
          if (latestTodosTs === null || (ts !== null && ts >= latestTodosTs)) {
            latestTodos = parsed;
            latestTodosTs = ts;
          }
        }
      }
    }
  }

  let needsAttention = false;
  if (latestBlocked !== null) {
    const blockedTs = typeof latestBlocked.ts === 'string' ? latestBlocked.ts : null;
    const blockedSession =
      typeof latestBlocked.session_id === 'string' && latestBlocked.session_id.length > 0
        ? latestBlocked.session_id
        : null;
    if (blockedSession !== null) {
      const resolver = latestSessionEndBySession.get(blockedSession);
      // Resolved iff a session_end for the same session is at or after the blocked ts.
      if (resolver === undefined || (blockedTs !== null && resolver < blockedTs)) {
        needsAttention = true;
      }
    } else {
      // No session_id on the blocked event: any later session_end resolves it.
      if (latestSessionEndAny === null || (blockedTs !== null && latestSessionEndAny < blockedTs)) {
        needsAttention = true;
      }
    }
  }

  const currentSubgoal =
    subgoalStack.length > 0 ? (subgoalStack[subgoalStack.length - 1] ?? null) : null;

  // Awake iff there's a session_start newer than every session_end. No
  // session_start ever ⇒ asleep. session_end newer than (or tied with) the
  // latest session_start ⇒ asleep.
  let liveSession = false;
  if (latestSessionStartTs !== null) {
    if (latestSessionEndAny === null) {
      liveSession = true;
    } else if (latestSessionStartTs > latestSessionEndAny) {
      liveSession = true;
    }
  }

  return {
    current_subgoal: currentSubgoal,
    latest_confidence: latestConfidence,
    needs_attention: needsAttention,
    todos: latestTodos,
    latest_activity: latestActivity,
    live_session: liveSession,
  };
}

// ---- helpers ---------------------------------------------------------------

/**
 * Read the tool name from a `tool_use` payload. Claude Code's hook payload
 * uses `tool_name`; some MCP-emitted shapes use `tool`. Accept either.
 */
function readToolName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { tool_name?: unknown; tool?: unknown };
  if (typeof p.tool_name === 'string' && p.tool_name.length > 0) return p.tool_name;
  if (typeof p.tool === 'string' && p.tool.length > 0) return p.tool;
  return null;
}

/**
 * Read the tool's input record from a `tool_use` payload. Tries the Claude
 * Code hook shape (`tool_input`) first, then the Anthropic API shape
 * (`input`).
 */
function readToolInput(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { tool_input?: unknown; input?: unknown };
  if (p.tool_input && typeof p.tool_input === 'object') {
    return p.tool_input as Record<string, unknown>;
  }
  if (p.input && typeof p.input === 'object') {
    return p.input as Record<string, unknown>;
  }
  return null;
}

function isTodoWritePayload(payload: unknown): boolean {
  return readToolName(payload) === 'TodoWrite';
}

/**
 * Pull the todo array out of a TodoWrite tool_use payload. The Claude Code
 * hook delivers it at `payload.tool_input.todos`; the API SDK shape would be
 * `payload.input.todos`; we also accept a top-level `payload.todos` as a
 * permissive last resort. Returns `null` on any structural error so the
 * projection caller falls back to the previous value.
 */
function parseTodos(payload: unknown): Todo[] | null {
  const input = readToolInput(payload);
  let raw: unknown =
    input && typeof input === 'object' ? (input as { todos?: unknown }).todos : undefined;
  if (raw === undefined && payload && typeof payload === 'object') {
    raw = (payload as { todos?: unknown }).todos;
  }
  if (!Array.isArray(raw)) return null;
  const out: Todo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    const content = typeof it.content === 'string' ? it.content : null;
    const status = typeof it.status === 'string' ? it.status : null;
    if (content === null || status === null) continue;
    if (!TODO_STATUSES.has(status)) continue;
    const todo: Todo = {
      content,
      status: status as Todo['status'],
    };
    if (typeof it.activeForm === 'string' && it.activeForm.length > 0) {
      todo.activeForm = it.activeForm;
    }
    out.push(todo);
  }
  // Even an empty array is a valid TodoWrite (the agent cleared its plan), so
  // don't coerce to null here — only return null when we couldn't parse at all.
  return out;
}

/**
 * Build a "Currently: …"-style line from a tool_use payload. Returns `null`
 * when no tool name can be read (the projection then sticks with the prior
 * value rather than blanking the field).
 *
 * Mapping (per the feature spec table):
 *   Edit   (path)    → "Editing <path>"
 *   Write  (path)    → "Writing <path>"
 *   Read   (path)    → "Reading <path>"
 *   Bash   (cmd)     → "Running: <first 60 chars of cmd>"
 *   Glob   (pattern) → "Searching for <pattern>"
 *   Grep   (pattern) → "Searching for <pattern>"
 *   WebFetch         → "Browsing the web"
 *   WebSearch        → "Browsing the web"
 *   <other>          → "Using <tool>"
 */
function humanizeToolUse(payload: unknown): string | null {
  const tool = readToolName(payload);
  if (tool === null) return null;
  const input = readToolInput(payload) ?? {};

  const path = stringOrNull(input['file_path']) ?? stringOrNull(input['path']);
  const command = stringOrNull(input['command']);
  const pattern = stringOrNull(input['pattern']) ?? stringOrNull(input['query']);

  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
      return path ? `Editing ${path}` : `Using ${tool}`;
    case 'Write':
      return path ? `Writing ${path}` : `Using ${tool}`;
    case 'Read':
      return path ? `Reading ${path}` : `Using ${tool}`;
    case 'Bash':
      if (command) {
        const first = command.length > 60 ? `${command.slice(0, 60)}…` : command;
        return `Running: ${first}`;
      }
      return `Using ${tool}`;
    case 'Glob':
    case 'Grep':
      return pattern ? `Searching for ${pattern}` : `Using ${tool}`;
    case 'WebFetch':
    case 'WebSearch':
      return 'Browsing the web';
    case 'TodoWrite':
      // The TodoWrite line is uninteresting on its own; the card surfaces
      // the parsed list. Keep a placeholder for the activity fallback so
      // downstream callers always have a string.
      return 'Updating plan';
    default:
      return `Using ${tool}`;
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}
