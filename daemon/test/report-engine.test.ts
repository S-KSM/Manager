import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore, type ManagerEvent } from '../src/event-store.js';
import { MemoryStore } from '../src/memory-store.js';
import { assembleReport } from '../src/report-engine.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('assembleReport', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-report-engine-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
  });

  afterEach(() => {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ev(
    workstreamId: string,
    type: ManagerEvent['type'],
    extra: Partial<ManagerEvent>,
  ): ManagerEvent {
    return {
      ts: new Date().toISOString(),
      workstream_id: workstreamId,
      type,
      ...extra,
    };
  }

  it('skips unknown workstream ids silently and never throws', async () => {
    registry.create('a', 'A');
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['a', 'nope'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    expect(ctx.workstreams).toHaveLength(1);
    expect(ctx.workstreams[0]!.id).toBe('a');
  });

  it('filters decisions/blockers to the requested window', async () => {
    registry.create('w', 'W');
    await eventStore.appendEvent(
      'w',
      ev('w', 'decision', {
        ts: '2026-04-01T00:00:00Z', // before window
        session_id: 's1',
        id: 'dec_old',
        payload: { considered: ['x'], choice: 'x', rationale: 'r', confidence: 0.5 },
      }),
    );
    await eventStore.appendEvent(
      'w',
      ev('w', 'decision', {
        ts: '2026-05-02T10:00:00Z',
        session_id: 's1',
        id: 'dec_in',
        payload: { considered: ['y'], choice: 'y', rationale: 'r', confidence: 0.9 },
      }),
    );
    await eventStore.appendEvent(
      'w',
      ev('w', 'blocked', {
        ts: '2026-05-03T10:00:00Z',
        session_id: 's1',
        id: 'blk_in',
        payload: { reason: 'need API key' },
      }),
    );
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['w'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    const snap = ctx.workstreams[0]!;
    expect(snap.decisions_in_window).toHaveLength(1);
    expect(snap.decisions_in_window[0]!.id).toBe('dec_in');
    expect(snap.blockers_in_window).toHaveLength(1);
    expect(snap.shipped_count).toBe(1);
  });

  it('caps decisions_in_window at 30 and orders most-recent first', async () => {
    registry.create('w', 'W');
    for (let i = 0; i < 40; i++) {
      const ts = new Date(Date.UTC(2026, 4, 2, 10, i, 0)).toISOString();
      await eventStore.appendEvent(
        'w',
        ev('w', 'decision', {
          ts,
          session_id: 's1',
          id: `dec_${i}`,
          payload: { considered: ['x'], choice: 'x', rationale: 'r', confidence: 0.5 },
        }),
      );
    }
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['w'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    const snap = ctx.workstreams[0]!;
    expect(snap.decisions_in_window).toHaveLength(30);
    // Most recent first.
    expect(snap.decisions_in_window[0]!.id).toBe('dec_39');
    expect(snap.shipped_count).toBe(40);
  });

  it('memory_excerpt is null when there is no memory file', async () => {
    registry.create('w', 'W');
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['w'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    expect(ctx.workstreams[0]!.memory_excerpt).toBeNull();
  });

  it('memory_excerpt truncates to a 2KB tail with a notice', async () => {
    registry.create('w', 'W');
    const big = 'x'.repeat(5000);
    await memoryStore.updateSection('w', 'Goal', big);
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['w'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    const excerpt = ctx.workstreams[0]!.memory_excerpt!;
    expect(excerpt.length).toBeLessThan(big.length);
    expect(excerpt).toContain('older sections truncated');
  });

  it('multi-workstream context preserves order and per-ws snapshot', async () => {
    registry.create('a', 'A');
    registry.create('b', 'B');
    await eventStore.appendEvent(
      'a',
      ev('a', 'decision', {
        ts: '2026-05-02T10:00:00Z',
        session_id: 'sa',
        id: 'dec_a',
        payload: { considered: ['1'], choice: '1', rationale: 'r', confidence: 0.7 },
      }),
    );
    await eventStore.appendEvent(
      'b',
      ev('b', 'blocked', {
        ts: '2026-05-02T11:00:00Z',
        session_id: 'sb',
        id: 'blk_b',
        payload: { reason: 'oops' },
      }),
    );
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['a', 'b'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    expect(ctx.workstreams.map((w) => w.id)).toEqual(['a', 'b']);
    expect(ctx.workstreams[0]!.shipped_count).toBe(1);
    expect(ctx.workstreams[1]!.blockers_in_window).toHaveLength(1);
    expect(ctx.workstreams[1]!.needs_attention).toBe(true);
  });

  it('active_seconds sums clamped session_start/session_end pairs in window', async () => {
    registry.create('w', 'W');
    await eventStore.appendEvent(
      'w',
      ev('w', 'session_start', {
        ts: '2026-05-02T10:00:00Z',
        session_id: 's1',
        id: 'ss_1',
      }),
    );
    await eventStore.appendEvent(
      'w',
      ev('w', 'session_end', {
        ts: '2026-05-02T11:00:00Z',
        session_id: 's1',
        id: 'se_1',
      }),
    );
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      {
        workstream_ids: ['w'],
        since: new Date('2026-05-01T00:00:00Z'),
        until: new Date('2026-05-08T00:00:00Z'),
      },
    );
    expect(ctx.workstreams[0]!.active_seconds).toBe(60 * 60);
  });

  it('echoes since/until ISO timestamps', async () => {
    const since = new Date('2026-05-01T00:00:00Z');
    const until = new Date('2026-05-08T00:00:00Z');
    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      { workstream_ids: [], since, until },
    );
    expect(ctx.since).toBe(since.toISOString());
    expect(ctx.until).toBe(until.toISOString());
    expect(ctx.workstreams).toHaveLength(0);
  });
});
