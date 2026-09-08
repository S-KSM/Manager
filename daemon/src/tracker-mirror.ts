import type { Issue, Tracker } from './trackers/index.js';
import { TrackerError } from './trackers/index.js';
import type { WorkstreamRegistry } from './workstream.js';
import { type WorkstreamLinksStore, toTrackerKind } from './workstream-links-store.js';

/**
 * TrackerMirror — v1.4.12. Background ticker that surfaces every Linear (or
 * mock) issue in the Radar as a `status='backlog'` workstream the moment it
 * appears in the tracker. Pairs with the existing `LinearCommentSyncer`
 * reverse-sync that handles tracker-state → workstream-status transitions.
 *
 * Decisions baked in:
 * - Only CREATES workstreams. Never demotes an existing `active` / `paused`
 *   one back to `backlog`. Promotion is a human gesture (drag → Active).
 * - Idempotent: workstream_links.findByIssueId is the dedup key. A second
 *   tick over the same issue re-finds the link and skips.
 * - Off by default. Activated only when `WORKFLOW.md` sets
 *   `tracker.mirror_to_radar: true`.
 *
 * Failure posture: a tick that throws (network blip, GraphQL error) logs
 * the failure and waits for the next interval. Mirror failures never abort
 * the orchestrator — they share the daemon process but not its state.
 */

export interface TrackerMirrorOptions {
  tracker: Tracker;
  registry: WorkstreamRegistry;
  links: WorkstreamLinksStore;
  /**
   * States to mirror. Typically the union of orchestrator `active_states`
   * + a few "not yet started" buckets like `Backlog` / `Triage` so the
   * Radar shows upcoming work, not just in-flight.
   */
  mirrorStates: string[];
  intervalMs: number;
  /**
   * Skip issues whose `created_at` is older than this many days. Stops
   * historical-burst on first run against a long-lived project. Null = no
   * cutoff.
   */
  maxAgeDays: number | null;
  /**
   * Optional id-sanitizer. Workstream ids must satisfy
   * `[A-Za-z0-9._-]` (Symphony §9 workspace key constraint). Defaults to
   * lowercased identifier with non-allowed chars replaced by `-`.
   */
  workstreamIdFor?: (issue: Issue) => string;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export class TrackerMirror {
  private readonly tracker: Tracker;
  private readonly registry: WorkstreamRegistry;
  private readonly links: WorkstreamLinksStore;
  private mirrorStates: string[];
  private intervalMs: number;
  private maxAgeDays: number | null;
  private readonly workstreamIdFor: (issue: Issue) => string;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: TrackerMirrorOptions) {
    this.tracker = opts.tracker;
    this.registry = opts.registry;
    this.links = opts.links;
    this.mirrorStates = opts.mirrorStates;
    this.intervalMs = opts.intervalMs;
    this.maxAgeDays = opts.maxAgeDays;
    this.workstreamIdFor = opts.workstreamIdFor ?? defaultIdFor;
    this.log = opts.log ?? (() => undefined);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Visible for tests. */
  async runOnce(): Promise<MirrorTickResult> {
    if (this.ticking || this.stopped) return { created: 0, skipped: 0 };
    this.ticking = true;
    let created = 0;
    let skipped = 0;
    try {
      let issues: Issue[];
      try {
        issues = await this.tracker.fetchCandidateIssues(this.mirrorStates);
      } catch (err) {
        if (err instanceof TrackerError) {
          this.log('mirror.fetch_failed', { code: err.code, message: err.message });
        } else {
          this.log('mirror.fetch_failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return { created: 0, skipped: 0 };
      }
      const cutoffMs =
        this.maxAgeDays !== null ? Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000 : null;
      for (const issue of issues) {
        if (cutoffMs !== null && issue.created_at) {
          const age = Date.parse(issue.created_at);
          if (Number.isFinite(age) && age < cutoffMs) {
            skipped++;
            continue;
          }
        }
        const existingLink = this.links.findByIssueId(issue.id);
        if (existingLink) {
          skipped++;
          continue;
        }
        const workstreamId = this.workstreamIdFor(issue);
        // Don't trample an existing workstream that happens to share the id —
        // the human may have created one manually. Just attach the link.
        const ensured = this.registry.get(workstreamId);
        if (!ensured) {
          this.registry.create(workstreamId, issue.title || issue.identifier, 'backlog');
        }
        this.links.link({
          workstreamId,
          trackerKind: toTrackerKind(this.tracker.kind) ?? 'linear',
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueUrl: issue.url ?? null,
          lastSeenState: issue.state,
        });
        created++;
        this.log('mirror.workstream_created', {
          workstream: workstreamId,
          issue: issue.identifier,
        });
      }
    } finally {
      this.ticking = false;
    }
    return { created, skipped };
  }

  applyConfig(
    opts: Partial<Pick<TrackerMirrorOptions, 'mirrorStates' | 'intervalMs' | 'maxAgeDays'>>,
  ): void {
    if (opts.mirrorStates) this.mirrorStates = opts.mirrorStates;
    if (opts.maxAgeDays !== undefined) this.maxAgeDays = opts.maxAgeDays;
    if (opts.intervalMs && opts.intervalMs !== this.intervalMs) {
      this.intervalMs = opts.intervalMs;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
      }
    }
  }
}

export interface MirrorTickResult {
  created: number;
  skipped: number;
}

/**
 * Default id derivation: lowercase the Linear identifier (`ENG-123` →
 * `eng-123`). The pattern matches the orchestrator's existing workspace-key
 * sanitization so a mirrored workstream is identical to one the orchestrator
 * would have spawned.
 */
function defaultIdFor(issue: Issue): string {
  const raw = issue.identifier.toLowerCase();
  return raw.replace(/[^a-z0-9._-]/g, '-');
}
