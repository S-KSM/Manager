import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDigest } from '../src/digest.js';
import { EventStore, type ManagerEvent } from '../src/event-store.js';
import { InterventionQueue } from '../src/intervention-queue.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('buildDigest', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let interventionQueue: InterventionQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-digest-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
  });

  afterEach(() => {
    interventionQueue.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ev(
    workstreamId: string,
    type: ManagerEvent['type'],
    extra: Partial<ManagerEvent> = {},
  ): ManagerEvent {
    return {
      ts: new Date().toISOString(),
      workstream_id: workstreamId,
      type,
      ...extra,
    };
  }

  it('totals counts shipped, blocked, active, needs_attention correctly', async () => {
    registry.create('a', 'A');
    registry.create('b', 'B');
    registry.create('c', 'C');
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1000).toISOString();
    // a: decision in window → shipped + active
    await eventStore.appendEvent(
      'a',
      ev('a', 'decision', {
        ts: inWindow,
        session_id: 's1',
        id: 'dec_a',
        payload: { considered: ['x'], choice: 'x', rationale: '', confidence: 0.9 },
      }),
    );
    // b: blocked event in window → needs_attention + active
    await eventStore.appendEvent(
      'b',
      ev('b', 'blocked', {
        ts: inWindow,
        session_id: 's2',
        id: 'blk_b',
        payload: { reason: 'need creds' },
      }),
    );
    // c: no events → quiet (not active, not shipped)

    const digest = await buildDigest({ registry, eventStore }, new Date(now.getTime() - 60_000));
    expect(digest.totals.shipped).toBe(1);
    expect(digest.totals.blocked).toBe(1);
    expect(digest.totals.needs_attention).toBe(1);
    expect(digest.totals.active).toBe(2);
  });

  it('highlights ordering: needs_attention first, then by event volume', async () => {
    registry.create('busy', 'Busy');
    registry.create('blockd', 'Blocked');
    registry.create('quiet', 'Quiet');
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1000).toISOString();
    // busy: 3 events
    for (let i = 0; i < 3; i++) {
      await eventStore.appendEvent(
        'busy',
        ev('busy', 'tool_use', {
          ts: inWindow,
          session_id: 's1',
          id: `t_${i}`,
          payload: {},
        }),
      );
    }
    // blockd: 1 blocked
    await eventStore.appendEvent(
      'blockd',
      ev('blockd', 'blocked', {
        ts: inWindow,
        session_id: 's2',
        id: 'blk',
        payload: { reason: 'stuck on Y' },
      }),
    );

    const digest = await buildDigest({ registry, eventStore }, new Date(now.getTime() - 60_000));
    expect(digest.highlights).toHaveLength(3);
    // blocked first
    expect(digest.highlights[0]!.workstream_id).toBe('blockd');
    expect(digest.highlights[0]!.summary).toContain('blocked');
    expect(digest.highlights[0]!.summary).toContain('stuck on Y');
    expect(digest.highlights[1]!.workstream_id).toBe('busy');
    expect(digest.highlights[2]!.workstream_id).toBe('quiet');
    expect(digest.highlights[2]!.summary).toBe('quiet');
  });

  it('highlights cap at 5', async () => {
    for (let i = 0; i < 7; i++) {
      const id = `w${i}`;
      registry.create(id, `W${i}`);
      await eventStore.appendEvent(
        id,
        ev(id, 'tool_use', {
          ts: new Date().toISOString(),
          session_id: 's',
          id: `t_${id}`,
          payload: {},
        }),
      );
    }
    const digest = await buildDigest({ registry, eventStore }, new Date(Date.now() - 60_000));
    expect(digest.highlights.length).toBe(5);
  });

  it('empty since-window: events older than since are not counted', async () => {
    registry.create('w1', 'W1');
    await eventStore.appendEvent(
      'w1',
      ev('w1', 'decision', {
        ts: '2020-01-01T00:00:00Z',
        session_id: 's1',
        id: 'dec_old',
        payload: { considered: ['x'], choice: 'x', rationale: '', confidence: 0.5 },
      }),
    );
    const digest = await buildDigest({ registry, eventStore }, new Date('2025-01-01T00:00:00Z'));
    expect(digest.totals.shipped).toBe(0);
    expect(digest.totals.active).toBe(0);
    expect(digest.highlights[0]!.summary).toBe('quiet');
  });

  it('shipped summary mentions decision count and confidence', async () => {
    registry.create('s1', 'S1');
    const t = new Date(Date.now() - 1000).toISOString();
    await eventStore.appendEvent(
      's1',
      ev('s1', 'decision', {
        ts: t,
        session_id: 'sess',
        id: 'dec_1',
        payload: { considered: ['x'], choice: 'x', rationale: '', confidence: 0.78 },
      }),
    );
    await eventStore.appendEvent(
      's1',
      ev('s1', 'decision', {
        ts: t,
        session_id: 'sess',
        id: 'dec_2',
        payload: { considered: ['y'], choice: 'y', rationale: '', confidence: 0.78 },
      }),
    );
    const digest = await buildDigest({ registry, eventStore }, new Date(Date.now() - 60_000));
    expect(digest.highlights[0]!.summary).toContain('shipped 2 decisions');
    expect(digest.highlights[0]!.summary).toContain('78%');
  });

  it('returns since echoed in ISO', async () => {
    const since = new Date('2026-05-01T00:00:00Z');
    const digest = await buildDigest({ registry, eventStore }, since);
    expect(digest.since).toBe('2026-05-01T00:00:00.000Z');
  });

  it('backlog workstream with no events does not count toward active bucket', async () => {
    // Create a backlog workstream and an active one. Only the active one
    // emits an event in-window, so totals.active should be 1 (not 2). The
    // backlog workstream has no activity yet.
    registry.create('act', 'Active', 'active');
    registry.create('bk', 'Backlog', 'backlog');
    await eventStore.appendEvent(
      'act',
      ev('act', 'tool_use', {
        ts: new Date(Date.now() - 1000).toISOString(),
        session_id: 's1',
        id: 't1',
        payload: {},
      }),
    );
    const digest = await buildDigest({ registry, eventStore }, new Date(Date.now() - 60_000));
    expect(digest.totals.active).toBe(1);
    expect(digest.buckets.active).toEqual(['act']);
    expect(digest.buckets.active).not.toContain('bk');
  });

  it('pending approval_required intervention counts toward needs_attention but not blocked', async () => {
    registry.create('a', 'A');
    interventionQueue.enqueue('a', 'approval_required', {
      approval_request: { summary: 'run rm -rf', tool: 'Bash' },
    });

    const digest = await buildDigest(
      { registry, eventStore, interventionQueue },
      new Date(Date.now() - 60_000),
    );
    expect(digest.totals.blocked).toBe(0);
    expect(digest.totals.needs_attention).toBe(1);
    expect(digest.highlights[0]!.summary).toBe('awaiting approval');
  });

  it('blocked + pending approval on the same workstream dedupes to 1 in needs_attention', async () => {
    registry.create('a', 'A');
    const t = new Date(Date.now() - 1000).toISOString();
    await eventStore.appendEvent(
      'a',
      ev('a', 'blocked', {
        ts: t,
        session_id: 's1',
        id: 'blk_a',
        payload: { reason: 'cant write' },
      }),
    );
    interventionQueue.enqueue('a', 'approval_required', { approval_request: { summary: 'x' } });

    const digest = await buildDigest(
      { registry, eventStore, interventionQueue },
      new Date(Date.now() - 60_000),
    );
    expect(digest.totals.blocked).toBe(1);
    expect(digest.totals.needs_attention).toBe(1);
    // blocked summary takes precedence over pending-approval wording
    expect(digest.highlights[0]!.summary).toContain('blocked');
  });

  it('live_sessions lists workstreams whose latest session_start is newer than its latest session_end', async () => {
    registry.create('alive', 'Alive');
    registry.create('dead', 'Dead');
    registry.create('reborn', 'Reborn');
    registry.create('never', 'Never started');
    // alive: started, no end
    await eventStore.appendEvent(
      'alive',
      ev('alive', 'session_start', {
        ts: '2026-05-02T10:00:00Z',
        session_id: 's1',
        id: 'ss_a',
      }),
    );
    // dead: started, then ended later
    await eventStore.appendEvent(
      'dead',
      ev('dead', 'session_start', {
        ts: '2026-05-02T10:00:00Z',
        session_id: 's2',
        id: 'ss_d',
      }),
    );
    await eventStore.appendEvent(
      'dead',
      ev('dead', 'session_end', {
        ts: '2026-05-02T11:00:00Z',
        session_id: 's2',
        id: 'se_d',
      }),
    );
    // reborn: started, ended, then started again
    await eventStore.appendEvent(
      'reborn',
      ev('reborn', 'session_start', {
        ts: '2026-05-02T10:00:00Z',
        session_id: 's3',
        id: 'ss_r1',
      }),
    );
    await eventStore.appendEvent(
      'reborn',
      ev('reborn', 'session_end', {
        ts: '2026-05-02T11:00:00Z',
        session_id: 's3',
        id: 'se_r1',
      }),
    );
    await eventStore.appendEvent(
      'reborn',
      ev('reborn', 'session_start', {
        ts: '2026-05-02T12:00:00Z',
        session_id: 's4',
        id: 'ss_r2',
      }),
    );
    // never: no session events at all

    const digest = await buildDigest({ registry, eventStore }, new Date('2026-05-01T00:00:00Z'));
    expect(digest.live_sessions.sort()).toEqual(['alive', 'reborn']);
    expect(digest.live_sessions).not.toContain('dead');
    expect(digest.live_sessions).not.toContain('never');
  });

  it('non-approval pending interventions (nudge/redirect) do NOT trigger needs_attention', async () => {
    registry.create('a', 'A');
    interventionQueue.enqueue('a', 'nudge', { message: 'consider X' });
    interventionQueue.enqueue('a', 'redirect', { message: 'first do Y' });

    const digest = await buildDigest(
      { registry, eventStore, interventionQueue },
      new Date(Date.now() - 60_000),
    );
    expect(digest.totals.needs_attention).toBe(0);
    expect(digest.totals.blocked).toBe(0);
  });
});
