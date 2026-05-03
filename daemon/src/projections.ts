import type { ManagerEvent } from './event-store.js';

/**
 * Home-view projections derived from a workstream's event log.
 *
 * These three fields are documented in `docs/ARCHITECTURE.md` under
 * "Workstream" and feed the macOS app's home cards. The projection is a
 * pure function of the events array; the caller is responsible for I/O
 * (reading events) and for any caching. v1 will index these in SQLite;
 * for v0/v0.5 file sizes, recomputing on each request is fine.
 */
export interface WorkstreamProjections {
  current_subgoal: string | null;
  latest_confidence: number | null;
  needs_attention: boolean;
}

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
 * The events array is assumed to be in chronological/file order — the
 * order returned by `EventStore.readEvents`.
 */
export function projectFromEvents(events: ManagerEvent[]): WorkstreamProjections {
  if (!Array.isArray(events) || events.length === 0) {
    return { current_subgoal: null, latest_confidence: null, needs_attention: false };
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

  return {
    current_subgoal: currentSubgoal,
    latest_confidence: latestConfidence,
    needs_attention: needsAttention,
  };
}
