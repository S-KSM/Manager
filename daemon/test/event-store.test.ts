import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore, type ManagerEvent } from '../src/event-store.js';

function makeEvent(
  workstream: string,
  type: ManagerEvent['type'],
  extra: Partial<ManagerEvent> = {},
): ManagerEvent {
  return {
    ts: new Date().toISOString(),
    workstream_id: workstream,
    type,
    ...extra,
  };
}

describe('EventStore', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-events-'));
    store = new EventStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('append + read round-trips', async () => {
    await store.appendEvent('ws1', makeEvent('ws1', 'session_start', { id: 'a' }));
    await store.appendEvent('ws1', makeEvent('ws1', 'decision', { id: 'b' }));
    const result = await store.readEvents('ws1');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.id).toBe('a');
    expect(result.events[1]?.id).toBe('b');
    expect(result.nextOffset).toBeGreaterThan(0);
  });

  it('reads from offset returns only newer events', async () => {
    await store.appendEvent('ws1', makeEvent('ws1', 'session_start', { id: 'a' }));
    const first = await store.readEvents('ws1');
    await store.appendEvent('ws1', makeEvent('ws1', 'decision', { id: 'b' }));
    const second = await store.readEvents('ws1', first.nextOffset);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.id).toBe('b');
    expect(second.nextOffset).toBeGreaterThan(first.nextOffset);
  });

  it('returns empty for missing workstream', async () => {
    const result = await store.readEvents('nope');
    expect(result.events).toEqual([]);
    expect(result.nextOffset).toBe(0);
  });

  it('serializes concurrent appends without corrupting JSONL', async () => {
    const N = 50;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      tasks.push(store.appendEvent('wsx', makeEvent('wsx', 'tool_use', { id: `e${i}` })));
    }
    await Promise.all(tasks);
    const result = await store.readEvents('wsx');
    expect(result.events).toHaveLength(N);
    const ids = new Set(result.events.map((e) => e.id));
    expect(ids.size).toBe(N);
  });

  it('tailEvents fires for events appended after subscription', async () => {
    await store.appendEvent('wst', makeEvent('wst', 'session_start', { id: 'a' }));
    const initial = await store.readEvents('wst');
    const seen: ManagerEvent[] = [];
    const tail = store.tailEvents('wst', initial.nextOffset, (ev) => seen.push(ev));
    try {
      // small delay to let the watcher arm.
      await new Promise((r) => setTimeout(r, 50));
      await store.appendEvent('wst', makeEvent('wst', 'decision', { id: 'b' }));
      await store.appendEvent('wst', makeEvent('wst', 'decision', { id: 'c' }));
      // wait for poller to run (1s) — give it 2s headroom.
      await waitFor(() => seen.length >= 2, 3000);
      expect(seen.map((e) => e.id)).toEqual(['b', 'c']);
    } finally {
      tail.close();
    }
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}
