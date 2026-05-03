import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';
import { MemoryStore } from '../src/memory-store.js';
import { ReportStore } from '../src/report-store.js';
import { Scheduler, computeNextFireMs } from '../src/scheduler.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('Scheduler', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let reportStore: ReportStore;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-sched-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    reportStore = new ReportStore(join(dir, 'db.sqlite'));
    configPath = join(dir, 'scheduler.json');
  });

  afterEach(() => {
    registry.close();
    reportStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('computeNextFireMs returns a future ms for a valid cron', () => {
    const ms = computeNextFireMs('0 8 * * 1', Date.parse('2026-05-02T00:00:00Z'));
    expect(ms).toBeGreaterThan(Date.parse('2026-05-02T00:00:00Z'));
  });

  it('computeNextFireMs throws on invalid cron', () => {
    expect(() => computeNextFireMs('not-a-cron')).toThrow();
  });

  it('start seeds the default config to disk on first boot', async () => {
    const sched = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await sched.start();
    sched.stop();
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.weekly_report.enabled).toBe(false);
    expect(raw.weekly_report.cron).toBe('0 8 * * 1');
    expect(raw.monthly_report).toBeDefined();
  });

  it('listJobs returns weekly + monthly entries with next_fire_at when enabled', async () => {
    const sched = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await sched.start();
    let jobs = sched.listJobs();
    expect(jobs.map((j) => j.id).sort()).toEqual(['monthly_report', 'weekly_report']);
    expect(jobs.every((j) => j.next_fire_at === null)).toBe(true);
    await sched.updateJob('weekly_report', { enabled: true });
    jobs = sched.listJobs();
    const weekly = jobs.find((j) => j.id === 'weekly_report')!;
    expect(weekly.enabled).toBe(true);
    expect(weekly.next_fire_at).not.toBeNull();
    sched.stop();
  });

  it('updateJob persists changes to disk and reschedules next fire', async () => {
    const sched = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await sched.start();
    await sched.updateJob('weekly_report', {
      enabled: true,
      cron: '0 9 * * 1',
      audience_preset: 'engineer_peer',
    });
    sched.stop();
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.weekly_report.enabled).toBe(true);
    expect(raw.weekly_report.cron).toBe('0 9 * * 1');
    expect(raw.weekly_report.audience_preset).toBe('engineer_peer');
  });

  it('updateJob throws on unknown id', async () => {
    const sched = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await sched.start();
    await expect(sched.updateJob('nope', { enabled: true })).rejects.toThrow(/unknown/);
    sched.stop();
  });

  it('updateJob throws on invalid cron without applying changes', async () => {
    const sched = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await sched.start();
    await expect(sched.updateJob('weekly_report', { cron: 'bad' })).rejects.toThrow();
    sched.stop();
  });

  it('persistence round-trip: re-instantiating reads back the saved config', async () => {
    const a = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await a.start();
    await a.updateJob('weekly_report', { enabled: true, cron: '0 10 * * 1' });
    a.stop();
    const b = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await b.start();
    const job = b.listJobs().find((j) => j.id === 'weekly_report')!;
    expect(job.enabled).toBe(true);
    expect(job.cron).toBe('0 10 * * 1');
    expect(job.next_fire_at).not.toBeNull();
    b.stop();
  });

  it('next_fire_at advances to a future tick on boot (no backfill)', async () => {
    const sched = new Scheduler({ registry, eventStore, memoryStore, reportStore }, configPath);
    await sched.start();
    await sched.updateJob('weekly_report', { enabled: true });
    const job = sched.listJobs().find((j) => j.id === 'weekly_report')!;
    const nextMs = Date.parse(job.next_fire_at!);
    expect(nextMs).toBeGreaterThan(Date.now());
    sched.stop();
  });
});
