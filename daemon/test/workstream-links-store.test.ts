import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkstreamLinksStore } from '../src/workstream-links-store.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('WorkstreamLinksStore', () => {
  let dir: string;
  let dbPath: string;
  let registry: WorkstreamRegistry;
  let store: WorkstreamLinksStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'links-'));
    dbPath = join(dir, 'db.sqlite');
    registry = new WorkstreamRegistry(dbPath);
    store = new WorkstreamLinksStore(dbPath);
  });

  afterEach(() => {
    store.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('link/get/list/unlink round-trip', () => {
    registry.create('frontend-refactor', 'Frontend');
    expect(store.list()).toEqual([]);
    expect(store.get('frontend-refactor')).toBeNull();

    const created = store.link({
      workstreamId: 'frontend-refactor',
      trackerKind: 'linear',
      issueId: 'lin_001',
      issueIdentifier: 'ENG-123',
      issueUrl: 'https://linear.app/x/issue/ENG-123',
      lastSeenState: 'In Progress',
    });
    expect(created.workstream_id).toBe('frontend-refactor');
    expect(created.issue_identifier).toBe('ENG-123');
    expect(created.last_seen_state).toBe('In Progress');
    expect(created.last_synced_at).toBeNull();

    const fetched = store.get('frontend-refactor');
    expect(fetched).toEqual(created);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.issue_identifier).toBe('ENG-123');

    store.unlink('frontend-refactor');
    expect(store.get('frontend-refactor')).toBeNull();
    // Idempotent — second unlink doesn't throw.
    store.unlink('frontend-refactor');
  });

  it('link upserts: re-linking a workstream replaces the prior row', () => {
    registry.create('w', 'W');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'lin_first',
      issueIdentifier: 'ENG-1',
    });
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'lin_second',
      issueIdentifier: 'ENG-2',
    });
    const got = store.get('w');
    expect(got?.issue_identifier).toBe('ENG-2');
    expect(got?.issue_id).toBe('lin_second');
  });

  it('setLastSeenState + setLastSyncedAt update only their column', () => {
    registry.create('w', 'W');
    store.link({
      workstreamId: 'w',
      trackerKind: 'linear',
      issueId: 'lin_x',
      issueIdentifier: 'ENG-9',
      lastSeenState: 'Todo',
    });
    store.setLastSeenState('w', 'In Progress');
    expect(store.get('w')?.last_seen_state).toBe('In Progress');

    store.setLastSyncedAt('w', '2026-05-06T10:00:00Z');
    const after = store.get('w');
    expect(after?.last_synced_at).toBe('2026-05-06T10:00:00Z');
    // last_seen_state unchanged.
    expect(after?.last_seen_state).toBe('In Progress');
  });

  it('markCommentPosted + hasCommentPosted are idempotent set semantics', () => {
    registry.create('w', 'W');
    expect(store.hasCommentPosted('dec_1')).toBe(false);
    store.markCommentPosted('dec_1', 'w');
    expect(store.hasCommentPosted('dec_1')).toBe(true);
    // Second call doesn't throw, and state is unchanged.
    store.markCommentPosted('dec_1', 'w');
    expect(store.hasCommentPosted('dec_1')).toBe(true);
    expect(store.hasCommentPosted('dec_2')).toBe(false);
  });

  it('FK enforcement: workstream_id references workstreams(id)', () => {
    // FK on a non-existent workstream id rejects the insert.
    expect(() =>
      store.link({
        workstreamId: 'no-such-workstream',
        trackerKind: 'linear',
        issueId: 'lin_y',
        issueIdentifier: 'ENG-2',
      }),
    ).toThrow();
  });
});
