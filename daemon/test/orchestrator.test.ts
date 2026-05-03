import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Orchestrator,
  type DispatchHook,
  type DispatchOutcome,
  sortCandidates,
} from '../src/orchestrator.js';
import type { Issue, Tracker } from '../src/trackers/index.js';
import { TrackerError } from '../src/trackers/index.js';
import { MockTracker } from '../src/trackers/mock.js';

function issue(over: Partial<Issue> & Pick<Issue, 'id' | 'identifier'>): Issue {
  return {
    id: over.id,
    identifier: over.identifier,
    title: over.title ?? `Title ${over.identifier}`,
    description: over.description ?? null,
    priority: over.priority ?? null,
    state: over.state ?? 'Todo',
    branch_name: over.branch_name ?? null,
    url: over.url ?? null,
    labels: over.labels ?? [],
    blocked_by: over.blocked_by ?? [],
    created_at: over.created_at ?? '2026-05-01T00:00:00.000Z',
    updated_at: over.updated_at ?? null,
  };
}

class StaticTracker implements Tracker {
  readonly kind = 'static';
  constructor(private readonly issues: Issue[]) {}
  async fetchCandidateIssues(active: string[]): Promise<Issue[]> {
    const set = new Set(active.map((s) => s.toLowerCase()));
    return this.issues.filter((i) => set.has(i.state.toLowerCase()));
  }
  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const set = new Set(states.map((s) => s.toLowerCase()));
    return this.issues.filter((i) => set.has(i.state.toLowerCase()));
  }
  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const wanted = new Set(ids);
    const out = new Map<string, string>();
    for (const i of this.issues) if (wanted.has(i.id)) out.set(i.id, i.state);
    return out;
  }
  /** Mutator for tests. */
  setIssues(issues: Issue[]): void {
    (this as unknown as { issues: Issue[] }).issues = issues;
  }
}

describe('sortCandidates', () => {
  it('sorts by priority asc, null last; then by created_at asc; then by identifier', () => {
    const out = sortCandidates([
      issue({ id: '4', identifier: 'D', priority: null, created_at: '2026-05-01T00:00:00Z' }),
      issue({ id: '1', identifier: 'A', priority: 2, created_at: '2026-05-01T00:00:00Z' }),
      issue({ id: '2', identifier: 'B', priority: 1, created_at: '2026-05-02T00:00:00Z' }),
      issue({ id: '3', identifier: 'C', priority: 1, created_at: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out.map((i) => i.identifier)).toEqual(['C', 'B', 'A', 'D']);
  });
});

describe('Orchestrator', () => {
  it('dispatches eligible issues up to the global concurrency cap', async () => {
    const issues = [
      issue({ id: '1', identifier: 'A', priority: 1 }),
      issue({ id: '2', identifier: 'B', priority: 2 }),
      issue({ id: '3', identifier: 'C', priority: 3 }),
    ];
    const tracker = new StaticTracker(issues);
    const dispatched: string[] = [];
    const dispatch: DispatchHook = vi.fn().mockImplementation(async (i: Issue) => {
      dispatched.push(i.identifier);
      // Hold "running" forever for this test by returning a never-resolving promise.
      return new Promise<DispatchOutcome>(() => {});
    });
    const orch = new Orchestrator({
      tracker,
      activeStates: ['Todo'],
      terminalStates: ['Done'],
      maxConcurrentAgents: 2,
      dispatchOne: dispatch,
    });
    await orch.tick();
    expect(dispatched).toEqual(['A', 'B']);
    expect(orch.snapshot().counts.running).toBe(2);
    orch.stop();
  });

  it('skips issues already running or claimed (no double dispatch)', async () => {
    const issues = [issue({ id: '1', identifier: 'A', priority: 1 })];
    const tracker = new StaticTracker(issues);
    const dispatch: DispatchHook = vi.fn().mockImplementation(
      () => new Promise<DispatchOutcome>(() => {}),
    );
    const orch = new Orchestrator({
      tracker,
      activeStates: ['Todo'],
      terminalStates: ['Done'],
      maxConcurrentAgents: 5,
      dispatchOne: dispatch,
    });
    await orch.tick();
    await orch.tick();
    await orch.tick();
    expect((dispatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    orch.stop();
  });

  it('does not dispatch a Todo issue with non-terminal blockers', async () => {
    const issues = [
      issue({
        id: '1',
        identifier: 'A',
        priority: 1,
        state: 'Todo',
        blocked_by: [{ id: 'b1', identifier: 'B', state: 'In Progress' }],
      }),
    ];
    const tracker = new StaticTracker(issues);
    const dispatch: DispatchHook = vi.fn();
    const orch = new Orchestrator({
      tracker,
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      dispatchOne: dispatch,
    });
    await orch.tick();
    expect(dispatch).not.toHaveBeenCalled();
    orch.stop();
  });

  it('skips dispatch on tracker fetch failure but does not throw', async () => {
    const tracker: Tracker = {
      kind: 'broken',
      async fetchCandidateIssues() {
        throw new TrackerError('linear_api_request', 'simulated');
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map();
      },
    };
    const dispatch: DispatchHook = vi.fn();
    const logs: string[] = [];
    const orch = new Orchestrator({
      tracker,
      activeStates: ['Todo'],
      terminalStates: ['Done'],
      dispatchOne: dispatch,
      log: (m) => logs.push(m),
    });
    await expect(orch.tick()).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logs).toContain('orchestrator.candidates_failed');
    orch.stop();
  });

  it('schedules a continuation retry after a clean worker exit', async () => {
    const issues = [issue({ id: '1', identifier: 'A', priority: 1 })];
    const tracker = new StaticTracker(issues);
    let calls = 0;
    const dispatch: DispatchHook = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return { ok: true };
      // Hold the second one open so we can assert it ran.
      return new Promise<DispatchOutcome>(() => {});
    });
    const orch = new Orchestrator({
      tracker,
      activeStates: ['Todo'],
      terminalStates: ['Done'],
      dispatchOne: dispatch,
    });
    await orch.tick();
    // Continuation delay is 1000ms; wait a touch longer so the retry timer fires.
    await new Promise((r) => setTimeout(r, 1100));
    expect(calls).toBe(2);
    orch.stop();
  });

  it('reconciliation drops running entries whose tracker state went terminal', async () => {
    const live = issue({ id: '1', identifier: 'A', state: 'In Progress' });
    const tracker = new StaticTracker([live]);
    const dispatch: DispatchHook = vi.fn().mockImplementation(
      () => new Promise<DispatchOutcome>(() => {}),
    );
    const orch = new Orchestrator({
      tracker,
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      dispatchOne: dispatch,
    });
    await orch.tick();
    expect(orch.snapshot().counts.running).toBe(1);
    // Flip tracker state to Done.
    tracker.setIssues([{ ...live, state: 'Done' }]);
    await orch.tick();
    expect(orch.snapshot().counts.running).toBe(0);
    orch.stop();
  });
});

describe('MockTracker', () => {
  let tmp: string;
  let path: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mock-tracker-'));
    path = join(tmp, 'tickets.json');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns issues filtered by active states (case-insensitive)', async () => {
    await writeFile(
      path,
      JSON.stringify({
        issues: [
          { id: '1', identifier: 'A', title: 'A', state: 'Todo' },
          { id: '2', identifier: 'B', title: 'B', state: 'In Progress' },
          { id: '3', identifier: 'C', title: 'C', state: 'Done' },
        ],
      }),
    );
    const tracker = new MockTracker(path);
    const out = await tracker.fetchCandidateIssues(['todo', 'in progress']);
    expect(out.map((i) => i.identifier).sort()).toEqual(['A', 'B']);
  });

  it('throws TrackerError(mock_source_missing) when file does not exist', async () => {
    const tracker = new MockTracker(join(tmp, 'no.json'));
    await expect(tracker.fetchCandidateIssues(['Todo'])).rejects.toBeInstanceOf(TrackerError);
  });

  it('throws TrackerError(mock_source_invalid) on bad JSON', async () => {
    await writeFile(path, '{ not json');
    const tracker = new MockTracker(path);
    await expect(tracker.fetchCandidateIssues(['Todo'])).rejects.toBeInstanceOf(TrackerError);
  });
});
