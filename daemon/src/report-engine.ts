import type { EventStore, ManagerEvent } from './event-store.js';
import type { MemoryStore } from './memory-store.js';
import { projectFromEvents } from './projections.js';
import type { WorkstreamRegistry, WorkstreamStatus } from './workstream.js';

/**
 * Per-workstream snapshot used as input to the LLM-rendered report.
 *
 * Pure data; built by `assembleReport` from the registry/event/memory stores.
 * The shape mirrors the v1.1 report-engine spec: home-view projections (sub-goal,
 * confidence, attention) plus in-window slices of decisions/blockers, a memory
 * excerpt, and aggregate counts the prompt template renders verbatim.
 */
export interface WorkstreamSnapshot {
  id: string;
  title: string;
  status: WorkstreamStatus;
  current_subgoal: string | null;
  latest_confidence: number | null;
  needs_attention: boolean;
  decisions_in_window: ManagerEvent[];
  blockers_in_window: ManagerEvent[];
  memory_excerpt: string | null;
  shipped_count: number;
  active_seconds: number;
}

export interface ReportContext {
  since: string;
  until: string;
  workstreams: WorkstreamSnapshot[];
}

export interface AssembleReportDeps {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  memoryStore: MemoryStore;
}

export interface AssembleReportArgs {
  workstream_ids: string[];
  since: Date;
  until: Date;
}

/** Cap to keep the LLM prompt bounded; most-recent N decisions per workstream. */
const DECISIONS_CAP = 30;
/** Cap to keep the LLM prompt bounded; tail bytes of the memory MD per workstream. */
const MEMORY_TAIL_BYTES = 2 * 1024;
const MEMORY_TRUNCATION_NOTICE = '\n\n(…older sections truncated)\n';

/**
 * Build a deterministic ReportContext for the requested workstream ids and
 * window.
 *
 * Defensive by design: unknown workstream ids are silently skipped, malformed
 * events are filtered out, and the function never throws on missing files.
 * The caller (HTTP handler) is responsible for further serialization.
 */
export async function assembleReport(
  deps: AssembleReportDeps,
  args: AssembleReportArgs,
): Promise<ReportContext> {
  const { registry, eventStore, memoryStore } = deps;
  const sinceIso = args.since.toISOString();
  const untilIso = args.until.toISOString();
  const snapshots: WorkstreamSnapshot[] = [];

  for (const id of args.workstream_ids) {
    const ws = registry.get(id);
    if (!ws) continue; // skip unknown silently

    const { events } = await eventStore.readEvents(id);
    const projection = projectFromEvents(events);

    const inWindow = events.filter((e) => isInWindow(e.ts, sinceIso, untilIso));
    const decisionsAll = inWindow.filter((e) => e.type === 'decision');
    const blockersAll = inWindow.filter((e) => e.type === 'blocked');
    // Most recent first, capped.
    const decisionsSorted = decisionsAll
      .slice()
      .sort((a, b) => compareTsDesc(a.ts, b.ts))
      .slice(0, DECISIONS_CAP);
    const blockersSorted = blockersAll.slice().sort((a, b) => compareTsDesc(a.ts, b.ts));

    const memoryRaw = await memoryStore.read(id);
    const memoryExcerpt = excerptMemory(memoryRaw);

    const activeSeconds = computeActiveSeconds(events, sinceIso, untilIso);

    snapshots.push({
      id: ws.id,
      title: ws.title,
      status: ws.status,
      current_subgoal: projection.current_subgoal,
      latest_confidence: projection.latest_confidence,
      needs_attention: projection.needs_attention,
      decisions_in_window: decisionsSorted,
      blockers_in_window: blockersSorted,
      memory_excerpt: memoryExcerpt,
      shipped_count: decisionsAll.length,
      active_seconds: activeSeconds,
    });
  }

  return {
    since: sinceIso,
    until: untilIso,
    workstreams: snapshots,
  };
}

function isInWindow(ts: string | undefined, sinceIso: string, untilIso: string): boolean {
  if (typeof ts !== 'string' || ts.length === 0) return false;
  return ts >= sinceIso && ts <= untilIso;
}

function compareTsDesc(a: string | undefined, b: string | undefined): number {
  const av = typeof a === 'string' ? a : '';
  const bv = typeof b === 'string' ? b : '';
  if (av === bv) return 0;
  return av < bv ? 1 : -1;
}

function excerptMemory(raw: string): string | null {
  if (!raw) return null;
  if (raw.length <= MEMORY_TAIL_BYTES) return raw;
  const tail = raw.slice(raw.length - MEMORY_TAIL_BYTES);
  return `${MEMORY_TRUNCATION_NOTICE.trim()}\n\n${tail}`;
}

/**
 * Sum of session_start → session_end intervals for events whose ts falls within
 * [since, until]. Sessions that started before `since` are clamped to `since`;
 * sessions still open at `until` are clamped to `until`. Sessions with a
 * start but no matching end inside the window are clamped to `until`.
 *
 * Matching is by `session_id`; events without a session_id are ignored.
 */
function computeActiveSeconds(events: ManagerEvent[], sinceIso: string, untilIso: string): number {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) return 0;

  // Map session_id → earliest start ts (ms) seen for that session, regardless of window.
  const startBySession = new Map<string, number>();
  // Map session_id → latest end ts (ms) seen.
  const endBySession = new Map<string, number>();
  for (const ev of events) {
    if (!ev || typeof ev.session_id !== 'string' || !ev.session_id.length) continue;
    if (typeof ev.ts !== 'string') continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t)) continue;
    if (ev.type === 'session_start') {
      const prior = startBySession.get(ev.session_id);
      if (prior === undefined || t < prior) startBySession.set(ev.session_id, t);
    } else if (ev.type === 'session_end') {
      const prior = endBySession.get(ev.session_id);
      if (prior === undefined || t > prior) endBySession.set(ev.session_id, t);
    }
  }

  let totalMs = 0;
  for (const [sessionId, startMs] of startBySession) {
    const endMs = endBySession.get(sessionId) ?? untilMs;
    // Intersect [startMs, endMs] with [sinceMs, untilMs].
    const lo = Math.max(startMs, sinceMs);
    const hi = Math.min(endMs, untilMs);
    if (hi > lo) totalMs += hi - lo;
  }
  return Math.round(totalMs / 1000);
}
