import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';

describe('MemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-memory-'));
    store = new MemoryStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a fresh file with a section when none exists', async () => {
    await store.updateSection('ws1', 'Goal', 'Migrate dashboard.');
    const md = await store.read('ws1');
    expect(md).toContain('# Workstream: ws1');
    expect(md).toContain('## Goal');
    expect(md).toContain('Migrate dashboard.');
  });

  it('appends a brand-new section to an existing file', async () => {
    await store.updateSection('ws2', 'Goal', 'A');
    await store.updateSection('ws2', 'Current state', 'B');
    const md = await store.read('ws2');
    expect(md.indexOf('## Goal')).toBeLessThan(md.indexOf('## Current state'));
    expect(md).toContain('A');
    expect(md).toContain('B');
  });

  it('replaces an existing section in place', async () => {
    await store.updateSection('ws3', 'Goal', 'A');
    await store.updateSection('ws3', 'Current state', 'B');
    await store.updateSection('ws3', 'Goal', 'A2');
    const md = await store.read('ws3');
    expect(md).toContain('A2');
    expect(md).not.toContain('\nA\n');
    // B section preserved
    expect(md).toContain('B');
    // Order preserved: Goal still before Current state
    expect(md.indexOf('## Goal')).toBeLessThan(md.indexOf('## Current state'));
  });

  it('readSection returns the section body or null', async () => {
    await store.updateSection('ws4', 'Goal', 'X\nY');
    const goal = await store.readSection('ws4', 'Goal');
    expect(goal).toBe('X\nY');
    const missing = await store.readSection('ws4', 'Nope');
    expect(missing).toBeNull();
  });

  it('case-insensitive section match on update', async () => {
    await store.updateSection('ws5', 'Goal', 'A');
    await store.updateSection('ws5', 'goal', 'A2');
    const md = await store.read('ws5');
    // Should still be exactly one Goal-ish heading
    const matches = md.match(/^##\s+goal/gim);
    expect(matches?.length).toBe(1);
    expect(md).toContain('A2');
  });
});
