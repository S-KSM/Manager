import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HandbookStore } from '../src/handbook-store.js';

describe('HandbookStore', () => {
  let dir: string;
  let store: HandbookStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-handbook-'));
    store = new HandbookStore(join(dir, 'handbook.md'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty string when handbook does not yet exist', async () => {
    expect(await store.read()).toBe('');
  });

  it('first appendSkill writes the H1 header and the section', async () => {
    await store.appendSkill('Pattern A', 'do A');
    const md = await store.read();
    expect(md.startsWith('# Team handbook')).toBe(true);
    expect(md).toContain('## Pattern A');
    expect(md).toContain('do A');
  });

  it('subsequent appendSkill appends rather than replacing', async () => {
    await store.appendSkill('A', 'body A');
    await store.appendSkill('B', 'body B');
    const md = await store.read();
    expect(md.indexOf('## A')).toBeGreaterThan(-1);
    expect(md.indexOf('## B')).toBeGreaterThan(md.indexOf('## A'));
    expect(md).toContain('body A');
    expect(md).toContain('body B');
    // Header only once.
    const headerMatches = md.match(/^# Team handbook/gm);
    expect(headerMatches?.length).toBe(1);
  });

  it('renders source footer with workstream + decision', async () => {
    await store.appendSkill('Pattern X', 'do X', {
      workstream_id: 'w1',
      decision_id: 'dec_07',
    });
    const md = await store.read();
    expect(md).toContain('_(from workstream w1 / decision dec_07)_');
  });

  it('renders source footer with only workstream when no decision_id', async () => {
    await store.appendSkill('Pattern Y', 'do Y', { workstream_id: 'w2' });
    const md = await store.read();
    expect(md).toContain('_(from workstream w2)_');
  });

  it('omits footer when source is undefined', async () => {
    await store.appendSkill('Pattern Z', 'do Z');
    const md = await store.read();
    expect(md).not.toContain('_(from');
  });

  it('serializes concurrent appendSkill calls without losing entries', async () => {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(store.appendSkill(`S${i}`, `body${i}`));
    }
    await Promise.all(tasks);
    const md = await store.read();
    for (let i = 0; i < 10; i++) {
      expect(md).toContain(`## S${i}`);
      expect(md).toContain(`body${i}`);
    }
  });
});
