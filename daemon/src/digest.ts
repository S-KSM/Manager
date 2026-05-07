import type { EventStore, ManagerEvent } from './event-store.js';
import type { InterventionQueue } from './intervention-queue.js';
import { projectFromEvents } from './projections.js';
import type { WorkstreamRegistry } from './workstream.js';

export interface DigestTotals {
  shipped: number;
  blocked: number;
  /**
   * Workstreams that need a human action — superset of `blocked`. A
   * workstream counts as `needs_attention` when:
   *   - it has an unresolved `blocked` event, OR
   *   - the InterventionQueue has at least one pending `approval_required`
   *     intervention for it (v1.4.4 approval bridge).
   * Per-workstream dedupe: a workstream that is *both* blocked and awaiting
   * approval still counts as one.
   */
  needs_attention: number;
  active: number;
}

/**
 * Per-bucket workstream-id membership. Same buckets as `DigestTotals` —
 * `<bucket>.length === totals.<bucket>`. Lets the macOS client filter the
 * Radar to a single bucket without re-implementing the predicate.
 */
export interface DigestBuckets {
  shipped: string[];
  blocked: string[];
  needs_attention: string[];
  active: string[];
}

export interface DigestHighlight {
  workstream_id: string;
  title: string;
  summary: string;
}

export interface Digest {
  since: string;
  totals: DigestTotals;
  buckets: DigestBuckets;
  highlights: DigestHighlight[];
  /**
   * Workstream ids that currently have a live Claude Code session — that is,
   * the most recent `session_start` is newer than the most recent
   * `session_end`. Workstreams whose session has been killed (or never had
   * one) are absent from this list. Pure presentation signal — independent of
   * lifecycle status — and used by the macOS Radar to render the
   * awake/asleep robot mascot. Disjoint from the buckets above.
   */
  live_sessions: string[];
}

interface BuildDeps {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  /**
   * Optional. When supplied, workstreams with a pending `approval_required`
   * intervention also count toward `needs_attention`. Absent in legacy
   * call sites that don't yet pass the queue (tests, etc.) — those keep
   * the pre-v1.4.4 blocked-only semantics.
   */
  interventionQueue?: InterventionQueue;
}

interface PerWorkstreamSummary {
  workstream_id: string;
  title: string;
  eventsInWindow: number;
  decisionsInWindow: number;
  needsAttention: boolean;
  blocked: boolean;
  pendingApprovals: number;
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
  const { registry, eventStore, interventionQueue } = deps;
  const sinceIso = since.toISOString();
  const summaries: PerWorkstreamSummary[] = [];

  let shippedCount = 0;
  let blockedCount = 0;
  let needsAttentionCount = 0;
  let activeCount = 0;
  const shippedIds: string[] = [];
  const blockedIds: string[] = [];
  const needsAttentionIds: string[] = [];
  const activeIds: string[] = [];
  const liveSessionIds: string[] = [];

  for (const ws of registry.list()) {
    const { events } = await eventStore.readEvents(ws.id);
    const projection = projectFromEvents(events);
    const eventsInWindow = events.filter((e) => isInWindow(e, sinceIso));
    const decisionsInWindow = eventsInWindow.filter((e) => e.type === 'decision');
    const wasShipped = decisionsInWindow.length > 0;
    const wasActive = eventsInWindow.length > 0;
    const blocked = projection.needs_attention;
    const pendingApprovals = interventionQueue
      ? interventionQueue.countPending(ws.id, 'approval_required')
      : 0;
    const needsAttention = blocked || pendingApprovals > 0;

    if (wasShipped) {
      shippedCount += 1;
      shippedIds.push(ws.id);
    }
    if (blocked) {
      blockedCount += 1;
      blockedIds.push(ws.id);
    }
    if (needsAttention) {
      needsAttentionCount += 1;
      needsAttentionIds.push(ws.id);
    }
    if (wasActive) {
      activeCount += 1;
      activeIds.push(ws.id);
    }
    if (projection.live_session) {
      liveSessionIds.push(ws.id);
    }

    const summary = buildSummary({
      events,
      eventsInWindow,
      decisionsInWindow,
      projection,
      needsAttention,
      blocked,
      pendingApprovals,
      wasShipped,
      wasActive,
    });

    summaries.push({
      workstream_id: ws.id,
      title: ws.title,
      eventsInWindow: eventsInWindow.length,
      decisionsInWindow: decisionsInWindow.length,
      needsAttention,
      blocked,
      pendingApprovals,
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
      blocked: blockedCount,
      needs_attention: needsAttentionCount,
      active: activeCount,
    },
    buckets: {
      shipped: shippedIds,
      blocked: blockedIds,
      needs_attention: needsAttentionIds,
      active: activeIds,
    },
    highlights,
    live_sessions: liveSessionIds,
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
  blocked: boolean;
  pendingApprovals: number;
  wasShipped: boolean;
  wasActive: boolean;
}

function buildSummary(args: SummaryArgs): string {
  const {
    eventsInWindow,
    decisionsInWindow,
    projection,
    needsAttention,
    blocked,
    pendingApprovals,
    wasShipped,
    wasActive,
  } = args;

  if (needsAttention) {
    if (blocked) {
      const reason = latestBlockedReason(eventsInWindow.length > 0 ? eventsInWindow : args.events);
      return reason ? `blocked: ${reason}` : 'blocked';
    }
    return pendingApprovals === 1 ? 'awaiting approval' : `awaiting ${pendingApprovals} approvals`;
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
