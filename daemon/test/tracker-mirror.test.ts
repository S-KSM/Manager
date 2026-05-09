import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrackerMirror } from '../src/tracker-mirror.js';
import type { Issue, Tracker } from '../src/trackers/index.js';
import { TrackerError } from '../src/trackers/index.js';
import { WorkstreamLinksStore } from '../src/workstream-links-store.js';
import { WorkstreamRegistry } from '../src/workstream.js';

function issue(over: Partial<Issue> & Pick<Issue, 'id' | 'identifier'>): Issue {
  return {
    id: over.id,
    identifier: over.identifier,
    title: over.title ?? `Title ${over.identifier}`,
    description: over.description ?? null,
    priority: over.priority ?? null,
    state: over.state ?? 'Backlog',
    branch_name: over.branch_name ?? null,
    url: over.url ?? `https://x/${over.identifier}`,
    labels: over.labels ?? [],
    blocked_by: over.blocked_by ?? [],
    created_at: over.created_at ?? '2026-05-01T00:00:00.000Z',
    updated_at: over.updated_at ?? null,
  };
}

class FakeTracker implements Tracker {
  readonly kind = 'fake';
  constructor(public issues: Issue[]) {}
  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.issues;
  }
  async fetchIssuesByStates(): Promise<Issue[]> {
    return [];
  }
  async fetchIssueStatesByIds(): Promise<Map<string, string>> {
    return new Map();
  }
}

describe('TrackerMirror (v1.4.12)', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let links: WorkstreamLinksStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirror-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    links = new WorkstreamLinksStore(join(dir, 'db.sqlite'));
  });
  afterEach(() => {
    links.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a backlog workstream + link for each new tracker issue', async () => {
    const tracker = new FakeTracker([
      issue({ id: 'i1', identifier: 'ENG-1' }),
      issue({ id: 'i2', identifier: 'ENG-2', title: 'second' }),
    ]);
    const mirror = new TrackerMirror({
      tracker,
      registry,
      links,
      mirrorStates: ['Backlog'],
      intervalMs: 60_000,
      maxAgeDays: null,
    });
    const r = await mirror.runOnce();
    expect(r).toEqual({ created: 2, skipped: 0 });
    expect(
      registry
        .list()
        .map((w) => w.id)
        .sort(),
    ).toEqual(['eng-1', 'eng-2']);
    expect(registry.get('eng-1')?.status).toBe('backlog');
    expect(links.findByIssueId('i1')?.workstream_id).toBe('eng-1');
  });

  it('idempotent: second tick over the same issues creates nothing new', async () => {
    const tracker = new FakeTracker([issue({ id: 'i1', identifier: 'ENG-1' })]);
    const mirror = new TrackerMirror({
      tracker,
      registry,
      links,
      mirrorStates: ['Backlog'],
      intervalMs: 60_000,
      maxAgeDays: null,
    });
    await mirror.runOnce();
    const r2 = await mirror.runOnce();
    expect(r2).toEqual({ created: 0, skipped: 1 });
    expect(registry.list()).toHaveLength(1);
  });

  it('does NOT downgrade an existing active workstream to backlog', async () => {
    // Pre-create an active workstream that the mirror would otherwise mint.
    registry.create('eng-1', 'pre-existing active', 'active');
    const tracker = new FakeTracker([issue({ id: 'i1', identifier: 'ENG-1' })]);
    const mirror = new TrackerMirror({
      tracker,
      registry,
      links,
      mirrorStates: ['Backlog'],
      intervalMs: 60_000,
      maxAgeDays: null,
    });
    await mirror.runOnce();
    expect(registry.get('eng-1')?.status).toBe('active');
    // But the link DOES get created so reverse-sync can find it.
    expect(links.findByIssueId('i1')?.workstream_id).toBe('eng-1');
  });

  it('skips issues older than maxAgeDays', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const newDate = new Date().toISOString();
    const tracker = new FakeTracker([
      issue({ id: 'old', identifier: 'OLD-1', created_at: oldDate }),
      issue({ id: 'new', identifier: 'NEW-1', created_at: newDate }),
    ]);
    const mirror = new TrackerMirror({
      tracker,
      registry,
      links,
      mirrorStates: ['Backlog'],
      intervalMs: 60_000,
      maxAgeDays: 7, // 7-day cutoff
    });
    const r = await mirror.runOnce();
    expect(r).toEqual({ created: 1, skipped: 1 });
    expect(registry.get('new-1')).not.toBeNull();
    expect(registry.get('old-1')).toBeNull();
  });

  it('logs mirror.fetch_failed on tracker error and returns zeros (no abort)', async () => {
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
    const logs: string[] = [];
    const mirror = new TrackerMirror({
      tracker,
      registry,
      links,
      mirrorStates: ['Backlog'],
      intervalMs: 60_000,
      maxAgeDays: null,
      log: (m) => logs.push(m),
    });
    const r = await mirror.runOnce();
    expect(r).toEqual({ created: 0, skipped: 0 });
    expect(logs).toContain('mirror.fetch_failed');
  });
});
