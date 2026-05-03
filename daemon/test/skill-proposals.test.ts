import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillProposalsStore } from '../src/skill-proposals.js';

describe('SkillProposalsStore', () => {
  let dir: string;
  let store: SkillProposalsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-skills-'));
    store = new SkillProposalsStore(join(dir, 'db.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('propose returns wire-format row with status=proposed and prop_ id prefix', () => {
    const p = store.propose({
      workstream_id: 'w1',
      title: 'Pattern X',
      body: 'do X',
      source_decision_id: 'dec_07',
    });
    expect(p.id).toMatch(/^prop_/);
    expect(p.workstream_id).toBe('w1');
    expect(p.title).toBe('Pattern X');
    expect(p.body).toBe('do X');
    expect(p.source_decision_id).toBe('dec_07');
    expect(p.status).toBe('proposed');
    expect(typeof p.proposed_at).toBe('string');
  });

  it('listProposed shows freshly-proposed rows oldest-first', async () => {
    const a = store.propose({ workstream_id: 'w1', title: 'A', body: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.propose({ workstream_id: 'w2', title: 'B', body: 'b' });
    const list = store.listProposed();
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('markPromoted moves the row out of listProposed and returns the updated row', () => {
    const p = store.propose({ workstream_id: 'w1', title: 'A', body: 'a' });
    const updated = store.markPromoted(p.id);
    expect(updated?.status).toBe('promoted');
    expect(store.listProposed()).toHaveLength(0);
  });

  it('markDismissed moves the row out of listProposed', () => {
    const p = store.propose({ workstream_id: 'w1', title: 'A', body: 'a' });
    const updated = store.markDismissed(p.id);
    expect(updated?.status).toBe('dismissed');
    expect(store.listProposed()).toHaveLength(0);
  });

  it('markPromoted on missing id returns null', () => {
    expect(store.markPromoted('prop_nope')).toBeNull();
  });

  it('source_decision_id is null on the wire when omitted', () => {
    const p = store.propose({ workstream_id: 'w1', title: 'A', body: 'a' });
    expect(p.source_decision_id).toBeNull();
  });

  it('get returns persisted row across method calls (round-trip)', () => {
    const p = store.propose({
      workstream_id: 'w1',
      title: 'A',
      body: 'a',
      source_decision_id: 'dec_07',
    });
    const got = store.get(p.id);
    expect(got).not.toBeNull();
    expect(got?.title).toBe('A');
    expect(got?.source_decision_id).toBe('dec_07');
  });
});
