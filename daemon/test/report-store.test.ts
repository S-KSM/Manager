import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReportStore } from '../src/report-store.js';

describe('ReportStore', () => {
  let dir: string;
  let store: ReportStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-reports-'));
    store = new ReportStore(join(dir, 'db.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(overrides: Partial<Parameters<ReportStore['create']>[0]> = {}) {
    return store.create({
      title: 'Weekly update',
      audience_preset: 'executive',
      audience_freetext: null,
      period_since: '2026-04-25T00:00:00Z',
      period_until: '2026-05-02T00:00:00Z',
      workstream_ids: ['a', 'b'],
      provider: 'claude',
      model: 'claude-sonnet-4-7',
      body_md: '# Hello',
      status: 'draft',
      ...overrides,
    });
  }

  it('create assigns rep_ id when absent and roundtrips workstream_ids array', () => {
    const r = seed();
    expect(r.id).toMatch(/^rep_/);
    expect(r.workstream_ids).toEqual(['a', 'b']);
    expect(r.audience_preset).toBe('executive');
    expect(r.status).toBe('draft');
    expect(r.saved_at).toBeNull();
  });

  it('create with status=saved sets saved_at', () => {
    const r = seed({ status: 'saved' });
    expect(r.status).toBe('saved');
    expect(r.saved_at).not.toBeNull();
  });

  it('list hides archived rows by default', () => {
    const a = seed();
    seed({ status: 'archived' });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(a.id);
  });

  it('list filters explicitly to archived when asked', () => {
    seed();
    const arch = seed({ status: 'archived' });
    const list = store.list({ status: 'archived' });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(arch.id);
  });

  it('list orders by generated_at DESC', async () => {
    const first = seed({ generated_at: '2026-05-01T00:00:00Z' });
    const second = seed({ generated_at: '2026-05-02T00:00:00Z' });
    const list = store.list();
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('get returns null for unknown id', () => {
    expect(store.get('rep_nope')).toBeNull();
  });

  it('update flipping status to saved sets saved_at', () => {
    const r = seed();
    expect(r.saved_at).toBeNull();
    const updated = store.update(r.id, { status: 'saved' });
    expect(updated?.status).toBe('saved');
    expect(updated?.saved_at).not.toBeNull();
  });

  it('update title only does not change saved_at', () => {
    const r = seed({ status: 'saved' });
    const before = r.saved_at;
    const updated = store.update(r.id, { title: 'renamed' });
    expect(updated?.title).toBe('renamed');
    expect(updated?.saved_at).toBe(before);
  });

  it('update on unknown id returns null', () => {
    expect(store.update('rep_nope', { title: 'x' })).toBeNull();
  });

  it('delete removes the row', () => {
    const r = seed();
    store.delete(r.id);
    expect(store.get(r.id)).toBeNull();
  });
});
