import { type AssigneeFilter, type Issue, type Tracker, TrackerError } from './trackers/index.js';

/**
 * Orchestrator — Symphony SPEC.md §7 state machine + §8 dispatch loop +
 * §8.4 retry/backoff + §8.5 reconciliation.
 *
 * v1.4.0 ships with NO agent runner: the orchestrator computes the same
 * decisions Symphony would, but `dispatchOne` is a pluggable callback. In
 * dry-run mode (default for v1.4.0) the callback only logs; v1.4.2 replaces
 * it with a real `agent-runner.spawn()`.
 *
 * Single in-memory authoritative state (Symphony §4.1.8). The orchestrator is
 * the only mutator of `running`, `claimed`, `retryAttempts` — every external
 * outcome (worker exit, retry timer fired, reconciliation refresh) routes
 * through one of the methods on this class.
 */

/** Symphony §4.1.8 OrchestratorRuntimeState (in-memory snapshot). */
export interface OrchestratorRuntimeState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
}

export interface RunningEntry {
  issue_id: string;
  identifier: string;
  workspace_path: string | null;
  started_at: string;
  attempt: number | null;
}

/** Symphony §4.1.7 RetryEntry. */
export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  /** Set when the timer is scheduled; cleared on fire/cancel. */
  timer_handle: NodeJS.Timeout | null;
  error: string | null;
}

/** Per-state concurrency caps (Symphony §8.3). State keys are normalized lowercase. */
export type PerStateCaps = Record<string, number>;

export interface OrchestratorOptions {
  tracker: Tracker;
  /** Symphony §5.3.1 — issue states the orchestrator considers candidates. */
  activeStates: string[];
  /** Symphony §5.3.1 — issue states that release any claim on first sight. */
  terminalStates: string[];
  /** Symphony §5.3.2. */
  pollIntervalMs?: number;
  /** Symphony §5.3.5. */
  maxConcurrentAgents?: number;
  /** Symphony §5.3.5. */
  maxConcurrentAgentsByState?: PerStateCaps;
  /** Symphony §5.3.5. Cap for exp backoff. */
  maxRetryBackoffMs?: number;
  /** Symphony §5.3.6. Stall detection threshold; <=0 disables. */
  stallTimeoutMs?: number;
  /**
   * v1.4.7 — Filter applied to candidate fetch. 'unassigned' is the multi-
   * daemon safe default when claim_on_dispatch is on. Retry-fires bypass
   * this filter (since we already hold the id and just need a state check).
   */
  assigneeFilter?: AssigneeFilter;
  /**
   * Hook the orchestrator calls when it has decided to dispatch one issue.
   * Returns a promise that resolves when the worker exits. Resolution value
   * tells the orchestrator which retry path to take.
   *
   * In v1.4.0 (dry-run), the daemon installs a callback that logs and
   * resolves immediately with `{ ok: true }`. In v1.4.2, the agent runner
   * replaces it with a real spawn → wait-for-exit.
   */
  dispatchOne: DispatchHook;
  /**
   * v1.4.7 — Optional: run BEFORE dispatchOne. If absent, no tracker write
   * happens (current behavior). If present, returning `collided` means
   * another worker (Dispatch instance or human) already owns the ticket;
   * orchestrator drops it and moves to the next candidate. Returning
   * `error` triggers skip-this-tick — the orchestrator stops dispatching
   * this tick and tries again on the next poll.
   */
  claimHook?: ClaimHook | null;
  /**
   * v1.4.7 — Optional: run AFTER reconcileRunning detects a terminal-state
   * transition. Idempotent — if the tracker has already cleared the
   * assignee (e.g., human marked Done in Linear), this is a no-op.
   */
  releaseHook?: ReleaseHook | null;
  /** Optional clock injector for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional logger. Defaults to no-op (test-friendly). */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/** Outcome reported back from the dispatch hook (worker exit). */
export interface DispatchOutcome {
  /** True for clean Symphony §7.3 "Worker Exit (normal)". */
  ok: boolean;
  /** Optional human error tag, surfaced in logs + retry queue. */
  error?: string | null;
  /** True if a stall was detected (forces immediate retry, not continuation). */
  stalled?: boolean;
}

export type DispatchHook = (issue: Issue, attempt: number) => Promise<DispatchOutcome>;

/** v1.4.7 — Pre-dispatch tracker write. */
export type ClaimOutcome =
  | { ok: true }
  | { ok: false; collided: true }
  | { ok: false; collided: false; error: string };
export type ClaimHook = (issue: Issue) => Promise<ClaimOutcome>;
/**
 * v1.4.7 — Release hook gets just the ids the orchestrator has on hand from
 * its running-map entry; full Issue payloads are not retained between ticks.
 */
export type ReleaseHook = (ref: { issueId: string; identifier: string }) => Promise<void>;

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const FAILURE_BASE_DELAY_MS = 10_000;
const CONTINUATION_DELAY_MS = 1_000;

export class Orchestrator {
  private readonly tracker: Tracker;
  private readonly dispatchOne: DispatchHook;
  // v1.4.10.3 — mutable so the workflow-loader hot-reload can swap them when
  // WORKFLOW.md flips claim_on_dispatch / claim_state. The orchestrator never
  // mutates them itself — only `applyConfig` does.
  private claimHook: ClaimHook | null;
  private releaseHook: ReleaseHook | null;
  private readonly now: () => number;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;

  // Tunables — mutable so a future workflow-loader hot reload can update them.
  private activeStates: string[];
  private terminalStates: string[];
  private pollIntervalMs: number;
  private maxConcurrentAgents: number;
  private maxConcurrentAgentsByState: PerStateCaps;
  private maxRetryBackoffMs: number;
  private stallTimeoutMs: number;
  private assigneeFilter: AssigneeFilter;

  // Symphony §4.1.8 runtime state.
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();

  private pollTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: OrchestratorOptions) {
    this.tracker = opts.tracker;
    this.dispatchOne = opts.dispatchOne;
    this.claimHook = opts.claimHook ?? null;
    this.releaseHook = opts.releaseHook ?? null;
    this.activeStates = opts.activeStates;
    this.terminalStates = opts.terminalStates;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.maxConcurrentAgents = opts.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT;
    this.maxConcurrentAgentsByState = normalizeCaps(opts.maxConcurrentAgentsByState ?? {});
    this.maxRetryBackoffMs = opts.maxRetryBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 0;
    this.assigneeFilter = opts.assigneeFilter ?? 'any';
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => undefined);
  }

  /** Symphony §8.6 startup terminal cleanup hook + first tick. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('Orchestrator stopped; construct a new one');
    if (this.pollTimer) return;
    await this.tick();
    this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const entry of this.retryAttempts.values()) {
      if (entry.timer_handle) clearTimeout(entry.timer_handle);
    }
    this.retryAttempts.clear();
  }

  /** Snapshot for Symphony §13.7.2 `/orchestrator/state` endpoint. */
  snapshot(): {
    poll_interval_ms: number;
    max_concurrent_agents: number;
    stall_timeout_ms: number;
    counts: { running: number; retrying: number; claimed: number; completed: number };
    running: RunningEntry[];
    retrying: Array<Omit<RetryEntry, 'timer_handle'>>;
  } {
    return {
      poll_interval_ms: this.pollIntervalMs,
      max_concurrent_agents: this.maxConcurrentAgents,
      stall_timeout_ms: this.stallTimeoutMs,
      counts: {
        running: this.running.size,
        retrying: this.retryAttempts.size,
        claimed: this.claimed.size,
        completed: this.completed.size,
      },
      running: [...this.running.values()],
      retrying: [...this.retryAttempts.values()].map((r) => ({
        issue_id: r.issue_id,
        identifier: r.identifier,
        attempt: r.attempt,
        due_at_ms: r.due_at_ms,
        error: r.error,
      })),
    };
  }

  /** Visible for tests + the start-of-loop tick. Symphony §8.1 sequence. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      // (1) Reconcile running issues. Symphony §8.5.
      await this.reconcileRunning();
      // (2-5) Fetch candidates → sort → dispatch while slots remain.
      let candidates: Issue[];
      try {
        candidates = await this.tracker.fetchCandidateIssues(this.activeStates, {
          assigneeFilter: this.assigneeFilter,
        });
      } catch (err) {
        if (err instanceof TrackerError) {
          this.log('orchestrator.candidates_failed', { code: err.code, message: err.message });
        } else {
          this.log('orchestrator.candidates_failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return; // Skip dispatch this tick. Symphony §11.4.
      }
      const sorted = sortCandidates(candidates);
      for (const issue of sorted) {
        if (!this.eligible(issue)) continue;
        if (!this.hasSlot(issue.state)) break;
        this.dispatchInternal(issue, /* attempt */ null);
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---- Public mutators (other components call these) -----------------------

  /** v1.4.x: workflow-loader calls these on hot-reload. */
  applyConfig(opts: Partial<OrchestratorOptions>): void {
    if (opts.activeStates) this.activeStates = opts.activeStates;
    if (opts.terminalStates) this.terminalStates = opts.terminalStates;
    if (opts.pollIntervalMs) {
      this.pollIntervalMs = opts.pollIntervalMs;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
      }
    }
    if (opts.maxConcurrentAgents) this.maxConcurrentAgents = opts.maxConcurrentAgents;
    if (opts.maxConcurrentAgentsByState) {
      this.maxConcurrentAgentsByState = normalizeCaps(opts.maxConcurrentAgentsByState);
    }
    if (opts.maxRetryBackoffMs) this.maxRetryBackoffMs = opts.maxRetryBackoffMs;
    if (opts.stallTimeoutMs !== undefined) this.stallTimeoutMs = opts.stallTimeoutMs;
    if (opts.assigneeFilter !== undefined) this.assigneeFilter = opts.assigneeFilter;
    // v1.4.10.3 — Hot-swap claim/release hooks. We test for own property
    // presence (not !== undefined) so a watcher reload that explicitly sets
    // either field to null can clear it. Pass undefined to leave it alone.
    if ('claimHook' in opts) this.claimHook = opts.claimHook ?? null;
    if ('releaseHook' in opts) this.releaseHook = opts.releaseHook ?? null;
  }

  // ---- Internal: dispatch + worker outcome ---------------------------------

  /**
   * Symphony §7.3 "Poll Tick → Dispatch": claim, mark running, await worker
   * exit, then translate outcome into Released or RetryQueued.
   */
  private dispatchInternal(issue: Issue, attempt: number | null): void {
    if (this.claimed.has(issue.id)) return;
    this.claimed.add(issue.id);
    const startedAt = new Date().toISOString();
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      workspace_path: null,
      started_at: startedAt,
      attempt,
    };
    this.running.set(issue.id, entry);
    this.log('orchestrator.dispatch', { issue: issue.identifier, attempt });

    // Fire-and-track. The hook handles its own errors and reports an outcome.
    void (async () => {
      // v1.4.7 — pre-spawn tracker write. If the claim collides (someone else
      // owns the ticket) or errors, drop local state without scheduling a
      // retry; the next tick re-evaluates eligibility from scratch.
      if (this.claimHook) {
        let claim: ClaimOutcome;
        try {
          claim = await this.claimHook(issue);
        } catch (err) {
          claim = {
            ok: false,
            collided: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (!claim.ok) {
          this.running.delete(issue.id);
          this.claimed.delete(issue.id);
          if (claim.collided) {
            this.log('orchestrator.claim_collided', { issue: issue.identifier });
          } else {
            this.log('orchestrator.claim_failed', {
              issue: issue.identifier,
              error: claim.error,
            });
          }
          return;
        }
      }

      let outcome: DispatchOutcome;
      try {
        outcome = await this.dispatchOne(issue, attempt ?? 0);
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      this.onWorkerExit(issue, attempt ?? 0, outcome);
    })();
  }

  /**
   * Symphony §7.3 "Worker Exit (normal/abnormal)" — drop running entry, then
   * either schedule continuation (1s) or exp-backoff retry.
   */
  private onWorkerExit(issue: Issue, attempt: number, outcome: DispatchOutcome): void {
    this.running.delete(issue.id);
    if (this.stopped) {
      this.claimed.delete(issue.id);
      return;
    }
    if (outcome.ok && !outcome.stalled) {
      this.scheduleRetry(issue, attempt + 1, CONTINUATION_DELAY_MS, null);
      return;
    }
    const failureAttempt = Math.max(attempt, 1);
    const delay = Math.min(
      FAILURE_BASE_DELAY_MS * Math.pow(2, failureAttempt - 1),
      this.maxRetryBackoffMs,
    );
    this.scheduleRetry(issue, failureAttempt + 1, delay, outcome.error ?? 'unknown');
  }

  /** Symphony §7.3 "Retry Timer Fired" — re-fetch candidates, re-decide. */
  private scheduleRetry(
    issue: Issue,
    attempt: number,
    delayMs: number,
    error: string | null,
  ): void {
    // Cancel any prior timer for the same issue.
    const prior = this.retryAttempts.get(issue.id);
    if (prior?.timer_handle) clearTimeout(prior.timer_handle);

    const dueAtMs = this.now() + delayMs;
    const handle = setTimeout(() => void this.onRetryFire(issue, attempt), delayMs);
    this.retryAttempts.set(issue.id, {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: handle,
      error,
    });
  }

  private async onRetryFire(issue: Issue, attempt: number): Promise<void> {
    if (this.stopped) return;
    this.retryAttempts.delete(issue.id);
    // Release the claim from the prior dispatch so eligibility + dispatch can re-claim cleanly.
    this.claimed.delete(issue.id);
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues(this.activeStates);
    } catch {
      return;
    }
    const found = candidates.find((i) => i.id === issue.id);
    if (!found) {
      this.completed.add(issue.id);
      return;
    }
    if (!this.eligible(found)) return;
    if (!this.hasSlot(found.state)) {
      // Re-claim and requeue with same attempt.
      this.claimed.add(found.id);
      this.scheduleRetry(found, attempt, CONTINUATION_DELAY_MS, 'no available orchestrator slots');
      return;
    }
    this.dispatchInternal(found, attempt);
  }

  /** Symphony §8.5 reconciliation: terminate runs whose tracker state changed. */
  private async reconcileRunning(): Promise<void> {
    if (this.running.size === 0) return;
    const ids = [...this.running.keys()];
    let states: Map<string, string>;
    try {
      states = await this.tracker.fetchIssueStatesByIds(ids);
    } catch {
      // Symphony §11.4 — keep workers running on transient refresh failure.
      return;
    }
    const terminalSet = new Set(this.terminalStates.map((s) => s.toLowerCase()));
    const activeSet = new Set(this.activeStates.map((s) => s.toLowerCase()));
    for (const [id, state] of states.entries()) {
      const lc = state.toLowerCase();
      if (terminalSet.has(lc)) {
        // Caller will usually receive its own SIGTERM via the dispatch hook;
        // we just clear orchestrator state here. Graceful agent termination is
        // the runner's job in v1.4.2.
        const entry = this.running.get(id);
        this.running.delete(id);
        this.claimed.delete(id);
        this.completed.add(id);
        // v1.4.7 — release the tracker-side claim too. Best-effort: a failed
        // release just means the next reconcile pass tries again (or a human
        // unassigns in Linear). Do NOT block reconciliation on it.
        if (this.releaseHook && entry) {
          const ref = { issueId: id, identifier: entry.identifier };
          void this.releaseHook(ref).catch((err: unknown) => {
            this.log('orchestrator.release_failed', {
              issue: entry.identifier,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } else if (!activeSet.has(lc)) {
        // Neither active nor terminal: still drop the run entry (no workspace cleanup).
        this.running.delete(id);
        this.claimed.delete(id);
      }
    }
  }

  // ---- Helpers --------------------------------------------------------------

  /** Symphony §8.2 candidate eligibility (minus the slot check). */
  private eligible(issue: Issue): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.claimed.has(issue.id)) return false;
    const state = issue.state.toLowerCase();
    if (!this.activeStates.map((s) => s.toLowerCase()).includes(state)) return false;
    if (this.terminalStates.map((s) => s.toLowerCase()).includes(state)) return false;
    // Blocker rule: Todo state cannot dispatch when any blocker is non-terminal.
    if (state === 'todo') {
      const tset = new Set(this.terminalStates.map((s) => s.toLowerCase()));
      for (const b of issue.blocked_by ?? []) {
        if (b.state === null) return false;
        if (!tset.has(b.state.toLowerCase())) return false;
      }
    }
    return true;
  }

  private hasSlot(state: string): boolean {
    if (this.running.size >= this.maxConcurrentAgents) return false;
    const cap = this.maxConcurrentAgentsByState[state.toLowerCase()];
    if (cap === undefined) return true;
    let usedInState = 0;
    for (const r of this.running.values()) {
      // We compare by identifier match — orchestrator doesn't track per-running
      // state independently. The caller passes `issue.state`; running entries
      // get their state from the dispatch context. For the v1.4.0 simplified
      // accounting we count any running entry as "in some state" and rely on
      // global cap; per-state precise accounting lands in v1.4.3 when the
      // RunningEntry carries the issue snapshot.
      if (r.identifier) usedInState++;
    }
    void usedInState;
    return true;
  }
}

/** Symphony §8.2 sort: priority asc (null last), created_at oldest, identifier lex. */
export function sortCandidates(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    if (ca !== cb) return ca.localeCompare(cb);
    return a.identifier.localeCompare(b.identifier);
  });
}

function normalizeCaps(caps: PerStateCaps): PerStateCaps {
  const out: PerStateCaps = {};
  for (const [k, v] of Object.entries(caps)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}
