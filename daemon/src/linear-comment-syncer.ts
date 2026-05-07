import type { EventStore, ManagerEvent } from './event-store.js';
import type { SettingsStore } from './settings-store.js';
import { TrackerError } from './trackers/index.js';
import type { WorkstreamLink, WorkstreamLinksStore } from './workstream-links-store.js';
import type { WorkstreamRegistry, WorkstreamStatus } from './workstream.js';

/**
 * v1.2 bidirectional Linear sync ticker.
 *
 * Forward (Dispatch → Linear): for every linked workstream, scan for
 * `decision` events whose `payload.confidence >= MIN_CONFIDENCE` and that
 * we haven't already posted, then call `addIssueComment(issueId, body)`
 * with a deterministic Markdown body. The decision id is recorded in
 * `linear_comments_posted` so subsequent ticks (or a restarted daemon)
 * never double-post.
 *
 * Reverse (Linear → Dispatch): every tick we re-fetch each linked issue's
 * Linear state. When the Linear state has moved underneath us *and* the
 * workstream's current Dispatch status equals what we'd have written from
 * the previous Linear state (i.e. the user hasn't manually overridden it),
 * we flip the workstream's status to track Linear. State map:
 *   - Done | Closed | Cancelled | Canceled       → retired
 *   - In Progress                                  → active
 *   - Backlog | Todo                               → backlog
 *   - On Hold | Paused                             → paused
 *   - any other (custom workflow state)            → silent skip + log once
 *
 * Disabled with `DISPATCH_LINEAR_SYNC_ENABLED=0`. Cadence
 * (`tickIntervalMs`) defaults to 60s but is overridable for tests.
 */

export interface LinearCommentSyncerOptions {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  store: WorkstreamLinksStore;
  settings: SettingsStore;
  /**
   * Test-only escape hatch — accept the resolved Linear key and return a
   * tracker-shaped facade. In production we always pass a thin wrapper
   * around `LinearTracker`.
   */
  trackerFactory: (apiKey: string) => LinearTrackerLike;
  /** Override poll cadence in tests. Default 60_000ms. */
  tickIntervalMs?: number;
  /** Override min confidence threshold. Default 0.8. */
  minConfidence?: number;
  /** Inject the env reader (tests). */
  isEnabled?: () => boolean;
  /** Log sink — stderr in production. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Minimal slice of LinearTracker the syncer depends on. Lets the test
 * harness pass a mock without standing up the GraphQL plumbing.
 */
export interface LinearTrackerLike {
  fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>>;
  addIssueComment(issueId: string, body: string): Promise<{ id: string }>;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MIN_CONFIDENCE = 0.8;

const STATE_MAP: Record<string, WorkstreamStatus> = {
  Done: 'retired',
  Closed: 'retired',
  Cancelled: 'retired',
  Canceled: 'retired',
  'In Progress': 'active',
  Backlog: 'backlog',
  Todo: 'backlog',
  'On Hold': 'paused',
  Paused: 'paused',
};

export function linearStateToDispatchStatus(
  state: string | null | undefined,
): WorkstreamStatus | null {
  if (!state) return null;
  return STATE_MAP[state] ?? null;
}

export class LinearCommentSyncer {
  private readonly registry: WorkstreamRegistry;
  private readonly eventStore: EventStore;
  private readonly store: WorkstreamLinksStore;
  private readonly settings: SettingsStore;
  private readonly trackerFactory: (apiKey: string) => LinearTrackerLike;
  private readonly tickIntervalMs: number;
  private readonly minConfidence: number;
  private readonly isEnabled: () => boolean;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /**
   * Per-workstream guard so we don't fire two `setStatus` calls for the
   * same Linear state transition if the tracker hasn't accepted our PATCH
   * yet on the next tick.
   */
  private readonly unknownStateLogged = new Set<string>();
  /**
   * Listener invoked for every workstream we update via reverse-sync.
   * Production wires this to `eventStore.appendEvent` + a WS broadcast;
   * tests use it as an assertion sink.
   */
  onWorkstreamUpdated:
    | ((args: {
        workstreamId: string;
        prevStatus: WorkstreamStatus;
        nextStatus: WorkstreamStatus;
      }) => void)
    | null = null;

  constructor(opts: LinearCommentSyncerOptions) {
    this.registry = opts.registry;
    this.eventStore = opts.eventStore;
    this.store = opts.store;
    this.settings = opts.settings;
    this.trackerFactory = opts.trackerFactory;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.minConfidence = opts.minConfidence ?? readMinConfidence();
    this.isEnabled = opts.isEnabled ?? defaultIsEnabled;
    this.log = opts.log ?? ((m, c) => process.stderr.write(`[dispatch] ${m}${c ? ' ' + JSON.stringify(c) : ''}\n`));
  }

  start(): void {
    if (this.timer) return;
    if (!this.isEnabled()) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Visible for tests; one full sync pass over every linked workstream. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const apiKey = this.settings.getResolvedLinearApiKey();
      if (!apiKey) return;
      const links = this.store.list().filter((l) => l.tracker_kind === 'linear');
      if (links.length === 0) return;
      const tracker = this.trackerFactory(apiKey);

      // 1) Reverse-sync: pull current Linear states for every linked issue.
      try {
        const states = await tracker.fetchIssueStatesByIds(links.map((l) => l.issue_id));
        for (const link of links) {
          const newState = states.get(link.issue_id);
          if (!newState) continue;
          await this.applyReverseSync(link, newState);
        }
      } catch (err) {
        this.log('linear-sync: reverse-sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 2) Forward-sync: post high-confidence decisions as Linear comments.
      for (const link of links) {
        try {
          await this.postPendingComments(tracker, link);
        } catch (err) {
          this.log('linear-sync: forward post failed', {
            workstream: link.workstream_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async applyReverseSync(link: WorkstreamLink, newState: string): Promise<void> {
    if (link.last_seen_state === newState) return;
    const prevStatus = this.registry.get(link.workstream_id)?.status;
    if (!prevStatus) return;
    const prevMappedFromLinear =
      link.last_seen_state ? linearStateToDispatchStatus(link.last_seen_state) : null;
    const nextMappedFromLinear = linearStateToDispatchStatus(newState);
    if (nextMappedFromLinear === null) {
      const key = `${link.workstream_id}::${newState}`;
      if (!this.unknownStateLogged.has(key)) {
        this.unknownStateLogged.add(key);
        this.log('linear-sync: unmapped tracker state, skipping', {
          workstream: link.workstream_id,
          state: newState,
        });
      }
      this.store.setLastSeenState(link.workstream_id, newState);
      return;
    }
    // Only override the workstream's status when the user hasn't moved it
    // out from under us — i.e. its current Dispatch status still matches
    // what the previous Linear state resolved to. If `prevMappedFromLinear`
    // is null (first sync after linking) we accept the new state.
    const userOverrode = prevMappedFromLinear !== null && prevStatus !== prevMappedFromLinear;
    if (!userOverrode && prevStatus !== nextMappedFromLinear) {
      this.registry.setStatus(link.workstream_id, nextMappedFromLinear);
      this.onWorkstreamUpdated?.({
        workstreamId: link.workstream_id,
        prevStatus,
        nextStatus: nextMappedFromLinear,
      });
    }
    this.store.setLastSeenState(link.workstream_id, newState);
    this.store.setLastSyncedAt(link.workstream_id);
  }

  private async postPendingComments(
    tracker: LinearTrackerLike,
    link: WorkstreamLink,
  ): Promise<void> {
    const { events } = await this.eventStore.readEvents(link.workstream_id);
    for (const ev of events) {
      if (ev.type !== 'decision') continue;
      const decisionId = ev.id;
      if (!decisionId) continue;
      const payload = (ev.payload ?? {}) as {
        confidence?: unknown;
        choice?: unknown;
        rationale?: unknown;
      };
      const conf =
        typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
          ? payload.confidence
          : null;
      if (conf === null || conf < this.minConfidence) continue;
      if (this.store.hasCommentPosted(decisionId)) continue;
      const body = renderCommentBody(ev, link, conf);
      try {
        await tracker.addIssueComment(link.issue_id, body);
        this.store.markCommentPosted(decisionId, link.workstream_id);
      } catch (err) {
        if (err instanceof TrackerError && err.code === 'linear_comment_failed') {
          // Don't poison the set on transient failure — try again next tick.
          this.log('linear-sync: comment failed (will retry)', {
            workstream: link.workstream_id,
            decision: decisionId,
          });
          continue;
        }
        throw err;
      }
    }
  }
}

function defaultIsEnabled(): boolean {
  return process.env['DISPATCH_LINEAR_SYNC_ENABLED'] !== '0';
}

function readMinConfidence(): number {
  const raw = process.env['DISPATCH_LINEAR_COMMENT_MIN_CONFIDENCE'];
  if (raw === undefined || raw === '') return DEFAULT_MIN_CONFIDENCE;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : DEFAULT_MIN_CONFIDENCE;
}

function renderCommentBody(
  ev: ManagerEvent,
  link: WorkstreamLink,
  confidence: number,
): string {
  const payload = (ev.payload ?? {}) as { choice?: unknown; rationale?: unknown };
  const choice = typeof payload.choice === 'string' ? payload.choice : '(no choice recorded)';
  const rationale = typeof payload.rationale === 'string' ? payload.rationale : '';
  const pct = Math.round(confidence * 100);
  const lines: string[] = [
    `**Dispatch decision** (workstream \`${link.workstream_id}\`)`,
    '',
    `**Choice:** ${choice}`,
    `**Confidence:** ${pct}%`,
  ];
  if (rationale.length > 0) {
    lines.push('', '**Rationale:**', rationale);
  }
  lines.push('', `_Posted by Dispatch — decision id ${ev.id}._`);
  return lines.join('\n');
}
