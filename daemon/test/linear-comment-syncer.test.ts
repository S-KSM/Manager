import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStore, type ManagerEvent } from '../src/event-store.js';
import {
  LinearCommentSyncer,
  type LinearTrackerLike,
  linearStateToDispatchStatus,
} from '../src/linear-comment-syncer.js';
import { SettingsStore } from '../src/settings-store.js';
import { TrackerError } from '../src/trackers/index.js';
import { WorkstreamLinksStore } from '../src/workstream-links-store.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('LinearCommentSyncer', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let store: WorkstreamLinksStore;
  let settings: SettingsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lsync-'));
    const dbPath = join(dir, 'db.sqlite');
    registry = new WorkstreamRegistry(dbPath);
    eventStore = new EventStore(join(dir, 'events'));
    store = new WorkstreamLinksStore(dbPath);
    settings = new SettingsStore(join(dir, 'settings.json'));
    settings.patch({ linearApiKey: 'lin_test' });
  });

  afterEach(() => {
    store.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function decision(
    wsId: string,
    id: string,
    confidence: number,
    extras: Partial<ManagerEvent> = {},
  ): ManagerEvent {
    return {
      ts: '2026-05-06T10:00:00Z',
      workstream_id: wsId,
      session_id: 's1',
      type: 'decision',
      id,
      payload: {
        considered: ['a', 'b'],
        choice: 'a',
        rationale: 'because',
        confidence,
      },
      ...extras,
    };
  }

  function makeMockTracker(overrides: Partial<LinearTrackerLike> = {}): LinearTrackerLike {
    return {
      fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
      addIssueComment: vi.fn().mockResolvedValue({ id: 'c_1' }),
      ...overrides,
    };
  }

  it('high-confidence decision posts exactly once across two ticks', async () => {
    registry.create('w', 'W');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'iss_1',
      issueIdentifier: 'ENG-1',
    });
    await eventStore.appendEvent('w', decision('w', 'dec_hi', 0.9));

    const tracker = makeMockTracker();
    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });

    await syncer.tick();
    await syncer.tick();
    expect((tracker.addIssueComment as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      1,
    );
    expect(store.hasCommentPosted('dec_hi')).toBe(true);
  });

  it('below-threshold decision is not posted', async () => {
    registry.create('w', 'W');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'iss_1',
      issueIdentifier: 'ENG-1',
    });
    await eventStore.appendEvent('w', decision('w', 'dec_lo', 0.5));

    const tracker = makeMockTracker();
    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });
    await syncer.tick();
    expect(tracker.addIssueComment).not.toHaveBeenCalled();
    expect(store.hasCommentPosted('dec_lo')).toBe(false);
  });

  it('unlinked workstream is skipped (no tracker calls)', async () => {
    registry.create('w', 'W');
    await eventStore.appendEvent('w', decision('w', 'dec_x', 0.9));

    const tracker = makeMockTracker();
    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });
    await syncer.tick();
    expect(tracker.addIssueComment).not.toHaveBeenCalled();
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it('reverse-sync flips workstream status + fires onWorkstreamUpdated', async () => {
    registry.create('w', 'W'); // default status = active
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'iss_1',
      issueIdentifier: 'ENG-1',
      lastSeenState: 'In Progress',
    });

    const tracker = makeMockTracker({
      fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map([['iss_1', 'Done']])),
    });
    const updates: { workstreamId: string; prevStatus: string; nextStatus: string }[] = [];

    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });
    syncer.onWorkstreamUpdated = (e) => updates.push(e);
    await syncer.tick();

    expect(registry.get('w')?.status).toBe('retired');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.nextStatus).toBe('retired');
    expect(store.get('w')?.last_seen_state).toBe('Done');
    expect(store.get('w')?.last_synced_at).not.toBeNull();
  });

  it('reverse-sync respects user override (no flip when status diverges from prior mapping)', async () => {
    registry.create('w', 'W');
    // User has manually paused the workstream after we last synced.
    registry.setStatus('w', 'paused');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'iss_1',
      issueIdentifier: 'ENG-1',
      // last_seen_state was "In Progress" → mapped to "active". Current
      // workstream status is "paused", so the user diverged from us.
      lastSeenState: 'In Progress',
    });

    const tracker = makeMockTracker({
      fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map([['iss_1', 'Done']])),
    });
    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });
    await syncer.tick();
    expect(registry.get('w')?.status).toBe('paused'); // user wins
    // last_seen_state still updates so we don't flip later when the user clears.
    expect(store.get('w')?.last_seen_state).toBe('Done');
  });

  it('reverse-sync silently skips unmapped Linear states', async () => {
    registry.create('w', 'W');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'iss_1',
      issueIdentifier: 'ENG-1',
      lastSeenState: 'In Progress',
    });
    const tracker = makeMockTracker({
      fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map([['iss_1', 'Custom-Workflow']])),
    });
    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });
    await syncer.tick();
    expect(registry.get('w')?.status).toBe('active');
  });

  it('mock-fetch failure is swallowed; comment failure does not poison the set', async () => {
    registry.create('w', 'W');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'iss_1',
      issueIdentifier: 'ENG-1',
    });
    await eventStore.appendEvent('w', decision('w', 'dec_hi', 0.9));

    let attempt = 0;
    const tracker: LinearTrackerLike = {
      fetchIssueStatesByIds: vi.fn().mockRejectedValue(new Error('network')),
      addIssueComment: vi.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new TrackerError('linear_comment_failed', 'transient');
        }
        return { id: 'c_1' };
      }),
    };
    const syncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store,
      settings,
      trackerFactory: () => tracker,
      isEnabled: () => true,
      log: () => undefined,
    });

    // First tick: reverse-sync rejects (swallowed), forward-sync raises
    // linear_comment_failed (swallowed; not marked posted).
    await syncer.tick();
    expect(store.hasCommentPosted('dec_hi')).toBe(false);

    // Second tick succeeds.
    await syncer.tick();
    expect(store.hasCommentPosted('dec_hi')).toBe(true);
  });

  it('linearStateToDispatchStatus maps the documented states', () => {
    expect(linearStateToDispatchStatus('Done')).toBe('retired');
    expect(linearStateToDispatchStatus('Closed')).toBe('retired');
    expect(linearStateToDispatchStatus('Cancelled')).toBe('retired');
    expect(linearStateToDispatchStatus('Canceled')).toBe('retired');
    expect(linearStateToDispatchStatus('In Progress')).toBe('active');
    expect(linearStateToDispatchStatus('Backlog')).toBe('backlog');
    expect(linearStateToDispatchStatus('Todo')).toBe('backlog');
    expect(linearStateToDispatchStatus('On Hold')).toBe('paused');
    expect(linearStateToDispatchStatus('Paused')).toBe('paused');
    expect(linearStateToDispatchStatus('Custom')).toBeNull();
    expect(linearStateToDispatchStatus(null)).toBeNull();
    expect(linearStateToDispatchStatus(undefined)).toBeNull();
  });
});
