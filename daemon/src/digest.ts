import type { EventStore, ManagerEvent } from './event-store.js';
import { projectFromEvents } from './projections.js';
import type { WorkstreamRegistry } from './workstream.js';

export interface DigestTotals {
  shipped: number;
  blocked: number;
  needs_attention: number;
  active: number;
}

export interface DigestHighlight {
  workstream_id: string;
  title: string;
  summary: string;
}

export interface Digest {
  since: string;
  totals: DigestTotals;
  highlights: DigestHighlight[];
}

interface BuildDeps {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
}

interface PerWorkstreamSummary {
  workstream_id: string;
  title: string;
  eventsInWindow: number;
  decisionsInWindow: number;
  needsAttention: boolean;
  summary: string;
}

/**
 * Build the morning digest by aggregating per-workstream activity since `since`.
 *
 * Reads each workstream's full event log (acceptable at v0/v0.5/v1 file
 * sizes; v1.1 will index in SQLite) and folds it through `projectFromEvents`
 * to derive current state. Per-workstream summary uses both the in-window
 * activity (for "shipped"/"active" wording) and the latest projection
 * fields (current sub-goal, latest confidence) for human-readable detail.
 */
export async function buildDigest(deps: BuildDeps, since: Date): Promise<Digest> {
  const { registry, eventStore } = deps;
  const sinceIso = since.toISOString();
  const summaries: PerWorkstreamSummary[] = [];

  let shippedCount = 0;
  let needsAttentionCount = 0;
  let activeCount = 0;

  for (const ws of registry.list()) {
    const { events } = await eventStore.readEvents(ws.id);
    const projection = projectFromEvents(events);
    const eventsInWindow = events.filter((e) => isInWindow(e, sinceIso));
    const decisionsInWindow = eventsInWindow.filter((e) => e.type === 'decision');
    const wasShipped = decisionsInWindow.length > 0;
    const wasActive = eventsInWindow.length > 0;
    const needsAttention = projection.needs_attention;

    if (wasShipped) shippedCount += 1;
    if (needsAttention) needsAttentionCount += 1;
    if (wasActive) activeCount += 1;

    const summary = buildSummary({
      events,
      eventsInWindow,
      decisionsInWindow,
      projection,
      needsAttention,
      wasShipped,
      wasActive,
    });

    summaries.push({
      workstream_id: ws.id,
      title: ws.title,
      eventsInWindow: eventsInWindow.length,
      decisionsInWindow: decisionsInWindow.length,
      needsAttention,
      summary,
    });
  }

  const highlights = summaries
    .slice()
    .sort((a, b) => {
      // needs_attention first, then by activity volume
      const attn = (b.needsAttention ? 1 : 0) - (a.needsAttention ? 1 : 0);
      if (attn !== 0) return attn;
      return b.eventsInWindow - a.eventsInWindow;
    })
    .slice(0, 5)
    .map((s) => ({
      workstream_id: s.workstream_id,
      title: s.title,
      summary: s.summary,
    }));

  return {
    since: sinceIso,
    totals: {
      shipped: shippedCount,
      blocked: needsAttentionCount,
      needs_attention: needsAttentionCount,
      active: activeCount,
    },
    highlights,
  };
}

function isInWindow(ev: ManagerEvent, sinceIso: string): boolean {
  return typeof ev.ts === 'string' && ev.ts >= sinceIso;
}

interface SummaryArgs {
  events: ManagerEvent[];
  eventsInWindow: ManagerEvent[];
  decisionsInWindow: ManagerEvent[];
  projection: {
    current_subgoal: string | null;
    latest_confidence: number | null;
    needs_attention: boolean;
  };
  needsAttention: boolean;
  wasShipped: boolean;
  wasActive: boolean;
}

function buildSummary(args: SummaryArgs): string {
  const { eventsInWindow, decisionsInWindow, projection, needsAttention, wasShipped, wasActive } =
    args;

  if (needsAttention) {
    const reason = latestBlockedReason(eventsInWindow.length > 0 ? eventsInWindow : args.events);
    return reason ? `blocked: ${reason}` : 'blocked';
  }

  if (wasShipped) {
    const n = decisionsInWindow.length;
    const conf = projection.latest_confidence;
    const subgoal = projection.current_subgoal;
    const confPart =
      typeof conf === 'number' ? `, current confidence ${Math.round(conf * 100)}%` : '';
    const subPart = subgoal ? `, current sub-goal "${subgoal}"` : '';
    return `shipped ${n} decision${n === 1 ? '' : 's'}${confPart}${subPart}`;
  }

  if (wasActive) {
    const subgoal = projection.current_subgoal;
    const subPart = subgoal ? `, current sub-goal "${subgoal}"` : '';
    return `active, no decisions yet${subPart}`;
  }

  return 'quiet';
}

function latestBlockedReason(events: ManagerEvent[]): string | null {
  let latest: ManagerEvent | null = null;
  for (const ev of events) {
    if (ev.type !== 'blocked') continue;
    if (latest === null) {
      latest = ev;
      continue;
    }
    const a = typeof latest.ts === 'string' ? latest.ts : '';
    const b = typeof ev.ts === 'string' ? ev.ts : '';
    if (b >= a) latest = ev;
  }
  if (!latest) return null;
  const reason =
    latest.payload && typeof latest.payload === 'object'
      ? (latest.payload as { reason?: unknown }).reason
      : undefined;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}
