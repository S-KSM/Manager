import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventStore } from '../src/event-store.js';
import { HandbookStore } from '../src/handbook-store.js';
import { buildHttpServer, type HttpServerHandle } from '../src/http-server.js';
import { InterventionQueue } from '../src/intervention-queue.js';
import { type LLMProvider, type LLMProviderName, LLMUnreachableError } from '../src/llm/index.js';
import { MemoryStore } from '../src/memory-store.js';
import { ReportStore } from '../src/report-store.js';
import { Scheduler } from '../src/scheduler.js';
import { SettingsStore } from '../src/settings-store.js';
import { SkillProposalsStore } from '../src/skill-proposals.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('HTTP server', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let interventionQueue: InterventionQueue;
  let eventStore: EventStore;
  let handbookStore: HandbookStore;
  let skillProposalsStore: SkillProposalsStore;
  let reportStore: ReportStore;
  let scheduler: Scheduler;
  let settings: SettingsStore;
  let handle: HttpServerHandle;
  let providerCalls: { name: LLMProviderName; system: string; user: string }[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-http-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    const memoryStore = new MemoryStore(join(dir, 'memory'));
    handbookStore = new HandbookStore(join(dir, 'handbook.md'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    reportStore = new ReportStore(join(dir, 'db.sqlite'));
    scheduler = new Scheduler(
      { registry, eventStore, memoryStore, reportStore },
      join(dir, 'scheduler.json'),
    );
    await scheduler.start();
    providerCalls = [];
    const fakeProvider = (name: LLMProviderName): LLMProvider => ({
      name,
      generate: async ({ system, user }) => {
        providerCalls.push({ name, system, user });
        return `# Mock ${name} report\n\nbody for tests`;
      },
    });
    settings = new SettingsStore(join(dir, 'settings.json'));
    handle = buildHttpServer({
      eventStore,
      memoryStore,
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      getProvider: fakeProvider,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await handle.close();
    interventionQueue.close();
    skillProposalsStore.close();
    reportStore.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('register workstream → POST hook → events endpoint contains it', async () => {
    const create = await request(handle.app)
      .post('/workstreams')
      .send({ id: 'demo', title: 'Demo workstream' });
    expect(create.status).toBe(201);
    expect(create.body.workstream_id).toBe('demo');

    const hook = await request(handle.app)
      .post('/hooks/session-start')
      .send({ workstream: 'demo', session: 'sess-abc', cwd: '/tmp' });
    expect(hook.status).toBe(202);

    const events = await request(handle.app).get('/workstreams/demo/events');
    expect(events.status).toBe(200);
    expect(events.body).toHaveLength(1);
    expect(events.body[0].type).toBe('session_start');
    expect(events.body[0].workstream_id).toBe('demo');
    expect(events.body[0].session_id).toBe('sess-abc');
    expect(events.body[0].payload.hook).toBe('session-start');
    expect(events.body[0].payload.cwd).toBe('/tmp');
  });

  it('returns 404 for unknown workstream', async () => {
    const r = await request(handle.app).get('/workstreams/missing');
    expect(r.status).toBe(404);
    const e = await request(handle.app).get('/workstreams/missing/events');
    expect(e.status).toBe(404);
  });

  it('lists workstreams and exposes detail with sessions (snake_case wire format)', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'a', title: 'A' });
    await request(handle.app).post('/hooks/session-start').send({ workstream: 'a', session: 's1' });

    const list = await request(handle.app).get('/workstreams');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].workstream_id).toBe('a');
    expect(list.body[0].title).toBe('A');
    expect(list.body[0]).toHaveProperty('created_at');
    expect(list.body[0]).toHaveProperty('memory_path');
    expect(list.body[0]).toHaveProperty('current_subgoal');
    expect(list.body[0]).toHaveProperty('latest_confidence');
    expect(list.body[0]).toHaveProperty('needs_attention');
    expect(list.body[0]).toHaveProperty('todos');
    expect(list.body[0]).toHaveProperty('latest_activity');
    expect(list.body[0]).toHaveProperty('last_event_at');

    const detail = await request(handle.app).get('/workstreams/a');
    expect(detail.status).toBe(200);
    expect(detail.body.workstream_id).toBe('a');
    expect(detail.body.sessions).toEqual(['s1']);
  });

  it('exposes /health for client live-vs-mock probe', async () => {
    const r = await request(handle.app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('memory endpoint returns markdown', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'b', title: 'B' });
    const r = await request(handle.app).get('/workstreams/b/memory');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/markdown');
  });

  it('POST /interventions (snake_case) persists; visible via GET pending', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'c', title: 'C' });
    const r = await request(handle.app)
      .post('/interventions')
      .send({ workstream_id: 'c', kind: 'nudge', payload: { message: 'hi' } });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^int_/);
    expect(r.body.workstream_id).toBe('c');
    expect(r.body.kind).toBe('nudge');
    expect(r.body.payload.message).toBe('hi');
    expect(r.body.delivered_at).toBeNull();

    const pending = await request(handle.app).get('/workstreams/c/interventions/pending');
    expect(pending.status).toBe(200);
    expect(Array.isArray(pending.body)).toBe(true);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0].id).toBe(r.body.id);
  });

  it('POST /interventions (camelCase body) is accepted for backwards-compat', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'c2', title: 'C2' });
    const r = await request(handle.app)
      .post('/interventions')
      .send({ workstreamId: 'c2', kind: 'nudge', payload: { message: 'legacy' } });
    expect(r.status).toBe(201);
    expect(r.body.workstream_id).toBe('c2');
  });

  it('POST /interventions rollback without rollback_to_decision_id → 400', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'c3', title: 'C3' });
    const r = await request(handle.app)
      .post('/interventions')
      .send({ workstream_id: 'c3', kind: 'rollback', payload: { message: 'go back' } });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
  });

  it('POST /interventions rollback with rollback_to_decision_id → 201', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'c4', title: 'C4' });
    const r = await request(handle.app)
      .post('/interventions')
      .send({
        workstream_id: 'c4',
        kind: 'rollback',
        payload: { message: 'reconsider', rollback_to_decision_id: 'dec_05' },
      });
    expect(r.status).toBe(201);
    expect(r.body.payload.rollback_to_decision_id).toBe('dec_05');
  });

  it('POST /interventions with unknown workstream → 404', async () => {
    const r = await request(handle.app)
      .post('/interventions')
      .send({ workstream_id: 'nope', kind: 'nudge', payload: { message: 'x' } });
    expect(r.status).toBe(404);
  });

  it('POST /interventions with bad kind → 400', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'c5', title: 'C5' });
    const r = await request(handle.app)
      .post('/interventions')
      .send({ workstream_id: 'c5', kind: 'bogus', payload: {} });
    expect(r.status).toBe(400);
  });

  it('GET /workstreams/:id/interventions/pending → 404 for unknown workstream', async () => {
    const r = await request(handle.app).get('/workstreams/missing/interventions/pending');
    expect(r.status).toBe(404);
  });

  it('POST ack empties pending and appends intervention_delivered event', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'd', title: 'D' });
    const enq = await request(handle.app)
      .post('/interventions')
      .send({ workstream_id: 'd', kind: 'nudge', payload: { message: 'wakeup' } });
    expect(enq.status).toBe(201);
    const id = enq.body.id as string;

    const ack = await request(handle.app)
      .post('/workstreams/d/interventions/ack')
      .send({ ids: [id] });
    expect(ack.status).toBe(200);
    expect(Array.isArray(ack.body)).toBe(true);
    expect(ack.body).toHaveLength(1);
    expect(ack.body[0].id).toBe(id);
    expect(ack.body[0].delivered_at).not.toBeNull();

    const pending = await request(handle.app).get('/workstreams/d/interventions/pending');
    expect(pending.body).toHaveLength(0);

    const events = await request(handle.app).get('/workstreams/d/events');
    const delivered = (
      events.body as Array<{ type: string; payload?: Record<string, unknown> }>
    ).filter((e) => e.type === 'intervention_delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload?.intervention_id).toBe(id);
    expect(delivered[0]!.payload?.kind).toBe('nudge');
    expect(delivered[0]!.payload?.message).toBe('wakeup');
  });

  it('POST ack with missing ids body → 400', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'e', title: 'E' });
    const r = await request(handle.app).post('/workstreams/e/interventions/ack').send({});
    expect(r.status).toBe(400);
  });

  it('POST ack with empty ids array → 400', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'f', title: 'F' });
    const r = await request(handle.app).post('/workstreams/f/interventions/ack').send({ ids: [] });
    expect(r.status).toBe(400);
  });

  it('POST ack is idempotent — re-acking the same id is a 200 with empty array', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'g', title: 'G' });
    const enq = await request(handle.app)
      .post('/interventions')
      .send({ workstream_id: 'g', kind: 'nudge', payload: { message: 'hi' } });
    const id = enq.body.id as string;
    const first = await request(handle.app)
      .post('/workstreams/g/interventions/ack')
      .send({ ids: [id] });
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(1);
    const second = await request(handle.app)
      .post('/workstreams/g/interventions/ack')
      .send({ ids: [id] });
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(0);
  });

  it('rejects malformed workstream creates', async () => {
    const r = await request(handle.app).post('/workstreams').send({ id: 'x' });
    expect(r.status).toBe(400);
  });

  it('GET /workstreams/:id returns real projections from the event log', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'p1', title: 'P1' });
    // Seed a curated event sequence directly via the event store.
    await eventStore.appendEvent('p1', {
      ts: '2026-05-02T10:00:00Z',
      workstream_id: 'p1',
      session_id: 's1',
      type: 'subgoal_push',
      id: 'sg_1',
      payload: { goal: 'migrate auth queries' },
    });
    await eventStore.appendEvent('p1', {
      ts: '2026-05-02T10:01:00Z',
      workstream_id: 'p1',
      session_id: 's1',
      type: 'decision',
      id: 'dec_07',
      payload: {
        considered: ['A', 'B', 'C'],
        choice: 'B',
        rationale: 'because Y',
        confidence: 0.72,
      },
    });

    const detail = await request(handle.app).get('/workstreams/p1');
    expect(detail.status).toBe(200);
    expect(detail.body.current_subgoal).toBe('migrate auth queries');
    expect(detail.body.latest_confidence).toBe(0.72);
    expect(detail.body.needs_attention).toBe(false);
  });

  it('GET /workstreams reflects needs_attention=true after a blocked event', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'p2', title: 'P2' });
    await eventStore.appendEvent('p2', {
      ts: '2026-05-02T10:00:00Z',
      workstream_id: 'p2',
      session_id: 's1',
      type: 'blocked',
      id: 'blk_1',
      payload: { reason: 'need creds' },
    });
    const list = await request(handle.app).get('/workstreams');
    expect(list.status).toBe(200);
    const p2 = (list.body as Array<{ workstream_id: string; needs_attention: boolean }>).find(
      (w) => w.workstream_id === 'p2',
    );
    expect(p2?.needs_attention).toBe(true);
  });

  it('GET /workstreams/:id/decisions/:decisionId returns the full event envelope', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'd1', title: 'D1' });
    await eventStore.appendEvent('d1', {
      ts: '2026-05-02T10:00:00Z',
      workstream_id: 'd1',
      session_id: 's1',
      type: 'decision',
      id: 'dec_07',
      parent_id: 'dec_05',
      payload: {
        considered: ['A', 'B'],
        choice: 'B',
        rationale: 'because Y',
        confidence: 0.72,
      },
    });
    const r = await request(handle.app).get('/workstreams/d1/decisions/dec_07');
    expect(r.status).toBe(200);
    expect(r.body.id).toBe('dec_07');
    expect(r.body.type).toBe('decision');
    expect(r.body.workstream_id).toBe('d1');
    expect(r.body.session_id).toBe('s1');
    expect(r.body.parent_id).toBe('dec_05');
    expect(r.body.ts).toBe('2026-05-02T10:00:00Z');
    expect(r.body.payload.choice).toBe('B');
    expect(r.body.payload.confidence).toBe(0.72);
  });

  it('GET /workstreams/:id/decisions/:decisionId → 404 for unknown decision', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'd2', title: 'D2' });
    const r = await request(handle.app).get('/workstreams/d2/decisions/nope');
    expect(r.status).toBe(404);
  });

  it('GET /workstreams/:id/decisions/:decisionId → 404 for unknown workstream', async () => {
    const r = await request(handle.app).get('/workstreams/missing/decisions/dec_01');
    expect(r.status).toBe(404);
  });

  // ---- Lifecycle: PATCH / DELETE ----------------------------------------

  it('PATCH /workstreams/:id sets status (active → paused) and emits workstream_updated', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'lc1', title: 'LC1' });
    const r = await request(handle.app).patch('/workstreams/lc1').send({ status: 'paused' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('paused');
    expect(r.body.workstream_id).toBe('lc1');
    const events = await request(handle.app).get('/workstreams/lc1/events');
    const updates = (
      events.body as Array<{ type: string; payload?: Record<string, unknown> }>
    ).filter((e) => e.type === 'workstream_updated');
    expect(updates).toHaveLength(1);
    const payload = updates[0]!.payload as {
      changes?: Record<string, unknown>;
      prev?: Record<string, unknown>;
    };
    expect(payload.changes?.['status']).toBe('paused');
    expect(payload.prev?.['status']).toBe('active');
  });

  it('PATCH /workstreams/:id sets title and emits workstream_updated', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'lc2', title: 'LC2' });
    const r = await request(handle.app).patch('/workstreams/lc2').send({ title: 'LC2 renamed' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('LC2 renamed');
    const events = await request(handle.app).get('/workstreams/lc2/events');
    const updates = (
      events.body as Array<{ type: string; payload?: Record<string, unknown> }>
    ).filter((e) => e.type === 'workstream_updated');
    expect(updates).toHaveLength(1);
    const payload = updates[0]!.payload as {
      changes?: Record<string, unknown>;
      prev?: Record<string, unknown>;
    };
    expect(payload.changes?.['title']).toBe('LC2 renamed');
    expect(payload.prev?.['title']).toBe('LC2');
  });

  it('PATCH /workstreams/:id with invalid status → 400 mentioning backlog', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'lc3', title: 'LC3' });
    const r = await request(handle.app).patch('/workstreams/lc3').send({ status: 'bogus' });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error).toContain('backlog');
  });

  it('PATCH /workstreams/:id sets status to backlog and emits workstream_updated', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'lcb', title: 'LCB' });
    const r = await request(handle.app).patch('/workstreams/lcb').send({ status: 'backlog' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('backlog');
    const events = await request(handle.app).get('/workstreams/lcb/events');
    const updates = (
      events.body as Array<{ type: string; payload?: Record<string, unknown> }>
    ).filter((e) => e.type === 'workstream_updated');
    expect(updates).toHaveLength(1);
    const payload = updates[0]!.payload as {
      changes?: Record<string, unknown>;
      prev?: Record<string, unknown>;
    };
    expect(payload.changes?.['status']).toBe('backlog');
    expect(payload.prev?.['status']).toBe('active');
  });

  it('PATCH /workstreams/:id on unknown id → 404', async () => {
    const r = await request(handle.app).patch('/workstreams/nope').send({ status: 'paused' });
    expect(r.status).toBe(404);
  });

  it('DELETE /workstreams/:id soft-deletes (status=retired) and returns the wire object', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'lc4', title: 'LC4' });
    const r = await request(handle.app).delete('/workstreams/lc4');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('retired');
    const detail = await request(handle.app).get('/workstreams/lc4');
    expect(detail.body.status).toBe('retired');
  });

  it('DELETE /workstreams/:id on unknown id → 404', async () => {
    const r = await request(handle.app).delete('/workstreams/missing');
    expect(r.status).toBe(404);
  });

  // ---- Digest -----------------------------------------------------------

  it('GET /digest aggregates totals and highlights across workstreams', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'da', title: 'DA' });
    await request(handle.app).post('/workstreams').send({ id: 'db', title: 'DB' });
    const now = new Date().toISOString();
    await eventStore.appendEvent('da', {
      ts: now,
      workstream_id: 'da',
      session_id: 's1',
      type: 'decision',
      id: 'dec_a',
      payload: { considered: ['x'], choice: 'x', rationale: 'r', confidence: 0.8 },
    });
    await eventStore.appendEvent('db', {
      ts: now,
      workstream_id: 'db',
      session_id: 's2',
      type: 'blocked',
      id: 'blk_b',
      payload: { reason: 'need API key' },
    });

    const r = await request(handle.app).get('/digest');
    expect(r.status).toBe(200);
    expect(r.body.totals.shipped).toBe(1);
    expect(r.body.totals.blocked).toBe(1);
    expect(r.body.totals.needs_attention).toBe(1);
    expect(r.body.totals.active).toBe(2);
    expect(Array.isArray(r.body.highlights)).toBe(true);
    expect(r.body.highlights.length).toBeGreaterThan(0);
    // blocked workstream should be first highlight
    expect(r.body.highlights[0].workstream_id).toBe('db');
  });

  it('GET /digest?since=<future> returns zero totals', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'dq', title: 'DQ' });
    await eventStore.appendEvent('dq', {
      ts: '2020-01-01T00:00:00Z',
      workstream_id: 'dq',
      session_id: 's1',
      type: 'decision',
      id: 'dec_old',
      payload: { considered: ['x'], choice: 'x', rationale: 'r', confidence: 0.5 },
    });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r = await request(handle.app).get(`/digest?since=${encodeURIComponent(future)}`);
    expect(r.status).toBe(200);
    expect(r.body.totals.shipped).toBe(0);
    expect(r.body.totals.active).toBe(0);
  });

  it('GET /digest?since=<garbage> → 400', async () => {
    const r = await request(handle.app).get('/digest?since=not-a-date');
    expect(r.status).toBe(400);
  });

  // ---- Handbook + skill broadcast --------------------------------------

  it('GET /handbook empty body when no handbook yet', async () => {
    const r = await request(handle.app).get('/handbook');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/markdown');
    expect(r.text).toBe('');
  });

  it('POST /handbook/skills appends a section visible via GET /handbook', async () => {
    const r = await request(handle.app)
      .post('/handbook/skills')
      .send({
        title: 'Pattern X',
        body: 'do X then Y',
        source: { workstream_id: 'a', decision_id: 'dec_a1' },
      });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('Pattern X');

    const get = await request(handle.app).get('/handbook');
    expect(get.status).toBe(200);
    expect(get.text).toContain('# Team handbook');
    expect(get.text).toContain('## Pattern X');
    expect(get.text).toContain('do X then Y');
    expect(get.text).toContain('workstream a / decision dec_a1');
  });

  it('POST /handbook/skills validates body', async () => {
    const r = await request(handle.app).post('/handbook/skills').send({ title: 'no body' });
    expect(r.status).toBe(400);
  });

  it('full skill-proposal-then-promote flow: handbook updated + skill_promoted event', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'sk', title: 'SK' });
    // Seed a proposal directly via the store (mimicking what propose_skill MCP does).
    const proposal = skillProposalsStore.propose({
      workstream_id: 'sk',
      title: 'Migrate via dual-read',
      body: 'do X then Y',
      source_decision_id: 'dec_sk',
    });
    expect(proposal.id).toMatch(/^prop_/);

    const list = await request(handle.app).get('/skills/proposed');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(proposal.id);

    const promote = await request(handle.app).post(`/skills/proposed/${proposal.id}/promote`);
    expect(promote.status).toBe(200);
    expect(promote.body.status).toBe('promoted');

    const handbook = await request(handle.app).get('/handbook');
    expect(handbook.text).toContain('## Migrate via dual-read');
    expect(handbook.text).toContain('do X then Y');
    expect(handbook.text).toContain('workstream sk / decision dec_sk');

    const events = await request(handle.app).get('/workstreams/sk/events');
    const promoted = (
      events.body as Array<{ type: string; payload?: Record<string, unknown> }>
    ).filter((e) => e.type === 'skill_promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.payload?.['proposal_id']).toBe(proposal.id);

    const after = await request(handle.app).get('/skills/proposed');
    expect(after.body).toHaveLength(0);

    // re-promote → 409
    const again = await request(handle.app).post(`/skills/proposed/${proposal.id}/promote`);
    expect(again.status).toBe(409);
  });

  it('POST /skills/proposed/:id/dismiss removes it from the proposed list', async () => {
    const proposal = skillProposalsStore.propose({
      workstream_id: 'sk2',
      title: 'X',
      body: 'Y',
    });
    const r = await request(handle.app).post(`/skills/proposed/${proposal.id}/dismiss`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('dismissed');
    const list = await request(handle.app).get('/skills/proposed');
    expect(list.body.find((p: { id: string }) => p.id === proposal.id)).toBeUndefined();
  });

  it('POST /skills/proposed/:id/promote → 404 for unknown id', async () => {
    const r = await request(handle.app).post('/skills/proposed/prop_nope/promote');
    expect(r.status).toBe(404);
  });

  // ---- Reports + presets + scheduler ------------------------------------

  it('GET /report-presets returns the built-in audience presets', async () => {
    const r = await request(handle.app).get('/report-presets');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(4);
    const ids = (r.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain('executive');
    expect(ids).toContain('engineer_peer');
  });

  it('POST /reports/generate (claude provider, mocked) persists a draft when save=false', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'r1', title: 'R1' });
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['r1'],
        audience_preset: 'executive',
        provider: 'claude',
      });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^rep_/);
    expect(r.body.status).toBe('draft');
    expect(r.body.body_md).toContain('Mock claude report');
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.name).toBe('claude');
    expect(providerCalls[0]!.system).toContain('executive summary');
  });

  it('POST /reports/generate with save=true persists status=saved + saved_at', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'r2', title: 'R2' });
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['r2'],
        audience_preset: 'executive',
        provider: 'ollama',
        save: true,
      });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('saved');
    expect(r.body.saved_at).not.toBeNull();
    expect(providerCalls[0]!.name).toBe('ollama');
  });

  it('POST /reports/generate with audience_freetext overrides the preset prompt', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'r3', title: 'R3' });
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['r3'],
        audience_preset: 'executive',
        audience_freetext: 'Series A investors, focus on traction',
        provider: 'claude',
      });
    expect(r.status).toBe(201);
    expect(providerCalls[0]!.system).toContain('Series A investors');
    expect(providerCalls[0]!.system).not.toContain('executive summary');
  });

  it('POST /reports/generate with bad provider → 400', async () => {
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({ workstream_ids: ['r4'], audience_preset: 'executive', provider: 'bogus' });
    expect(r.status).toBe(400);
  });

  it('POST /reports/generate with unknown audience_preset → 400', async () => {
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({ workstream_ids: ['r5'], audience_preset: 'nope', provider: 'claude' });
    expect(r.status).toBe(400);
  });

  it('POST /reports/generate without preset and without freetext → 400', async () => {
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({ workstream_ids: ['r6'], provider: 'claude' });
    expect(r.status).toBe(400);
  });

  it('POST /reports/generate maps LLMUnreachableError → 503', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'r7', title: 'R7' });
    // Rebuild the server with a provider that throws Unreachable.
    await handle.close();
    handle = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      getProvider: (name) => ({
        name,
        generate: async () => {
          throw new LLMUnreachableError('not reachable');
        },
      }),
    });
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['r7'],
        audience_preset: 'executive',
        provider: 'ollama',
      });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('LLM_UNREACHABLE');
  });

  it('GET /reports lists draft + saved by default; ?status=archived hides them', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'rl', title: 'RL' });
    await request(handle.app)
      .post('/reports/generate')
      .send({ workstream_ids: ['rl'], audience_preset: 'executive', provider: 'claude' });
    await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['rl'],
        audience_preset: 'executive',
        provider: 'claude',
        save: true,
      });
    const list = await request(handle.app).get('/reports');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const onlySaved = await request(handle.app).get('/reports?status=saved');
    expect(onlySaved.body).toHaveLength(1);
    expect(onlySaved.body[0].status).toBe('saved');
  });

  it('GET /reports/:id returns the report; PATCH updates fields; DELETE archives', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'rd', title: 'RD' });
    const gen = await request(handle.app)
      .post('/reports/generate')
      .send({ workstream_ids: ['rd'], audience_preset: 'executive', provider: 'claude' });
    const id = gen.body.id as string;

    const got = await request(handle.app).get(`/reports/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(id);

    const patched = await request(handle.app)
      .patch(`/reports/${id}`)
      .send({ title: 'Renamed', status: 'saved' });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Renamed');
    expect(patched.body.status).toBe('saved');
    expect(patched.body.saved_at).not.toBeNull();

    const del = await request(handle.app).delete(`/reports/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.status).toBe('archived');

    const after = await request(handle.app).get('/reports');
    expect(after.body.find((r: { id: string }) => r.id === id)).toBeUndefined();
  });

  it('GET /reports/:id → 404 for unknown id', async () => {
    const r = await request(handle.app).get('/reports/rep_nope');
    expect(r.status).toBe(404);
  });

  it('PATCH /reports/:id with bad status → 400', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'rp', title: 'RP' });
    const gen = await request(handle.app)
      .post('/reports/generate')
      .send({ workstream_ids: ['rp'], audience_preset: 'executive', provider: 'claude' });
    const r = await request(handle.app).patch(`/reports/${gen.body.id}`).send({ status: 'bogus' });
    expect(r.status).toBe(400);
  });

  it('GET /scheduler/jobs returns weekly + monthly entries', async () => {
    const r = await request(handle.app).get('/scheduler/jobs');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const ids = (r.body as Array<{ id: string }>).map((j) => j.id).sort();
    expect(ids).toEqual(['monthly_report', 'weekly_report']);
  });

  it('PATCH /scheduler/jobs/:id enables job and reschedules next_fire_at', async () => {
    const r = await request(handle.app)
      .patch('/scheduler/jobs/weekly_report')
      .send({ enabled: true, cron: '0 9 * * 1' });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.cron).toBe('0 9 * * 1');
    expect(r.body.next_fire_at).not.toBeNull();
  });

  it('PATCH /scheduler/jobs/:id with bad cron → 400', async () => {
    const r = await request(handle.app)
      .patch('/scheduler/jobs/weekly_report')
      .send({ cron: 'definitely-not-cron' });
    expect(r.status).toBe(400);
  });

  it('PATCH /scheduler/jobs/:id with unknown id → 404', async () => {
    const r = await request(handle.app)
      .patch('/scheduler/jobs/does_not_exist')
      .send({ enabled: true });
    expect(r.status).toBe(404);
  });

  // ---- Settings ------------------------------------------------------------

  it('GET /settings returns defaults with anthropicApiKeyConfigured=false', async () => {
    // Tests run in a tmp DISPATCH_HOME so the env-var fallback is the only
    // possible source of an API key. Save+restore the key to keep the test
    // hermetic.
    const prior = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const r = await request(handle.app).get('/settings');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        headlineProvider: 'ollama',
        ollamaUrl: 'http://localhost:11434',
        anthropicApiKeyConfigured: false,
      });
      expect(typeof r.body.headlineModel).toBe('string');
      expect(r.body.anthropicApiKey).toBeUndefined();
    } finally {
      if (prior !== undefined) process.env['ANTHROPIC_API_KEY'] = prior;
    }
  });

  it('PATCH /settings persists provider+model+ollamaUrl and redacts key', async () => {
    const r = await request(handle.app).patch('/settings').send({
      headlineProvider: 'claude',
      headlineModel: 'claude-haiku-4-5-20251001',
      ollamaUrl: 'http://localhost:9999',
      anthropicApiKey: 'sk-ant-test',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      headlineProvider: 'claude',
      headlineModel: 'claude-haiku-4-5-20251001',
      ollamaUrl: 'http://localhost:9999',
      anthropicApiKeyConfigured: true,
    });
    // Key never round-trips back.
    expect(r.body.anthropicApiKey).toBeUndefined();

    // GET sees the same redacted shape.
    const get = await request(handle.app).get('/settings');
    expect(get.body.anthropicApiKeyConfigured).toBe(true);
    expect(get.body.anthropicApiKey).toBeUndefined();

    // In-process the resolver still has the cleartext key for the provider.
    expect(settings.getResolvedAnthropicApiKey()).toBe('sk-ant-test');
  });

  it('PATCH /settings rejects bad provider with 400', async () => {
    const r = await request(handle.app)
      .patch('/settings')
      .send({ headlineProvider: 'gpt-99' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/headlineProvider/);
  });

  it('PATCH /settings with empty anthropicApiKey clears the stored value', async () => {
    await request(handle.app).patch('/settings').send({ anthropicApiKey: 'sk-ant-test' });
    expect(settings.getResolvedAnthropicApiKey()).toBe('sk-ant-test');
    const prior = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const cleared = await request(handle.app).patch('/settings').send({ anthropicApiKey: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.anthropicApiKeyConfigured).toBe(false);
      expect(settings.getResolvedAnthropicApiKey()).toBeUndefined();
    } finally {
      if (prior !== undefined) process.env['ANTHROPIC_API_KEY'] = prior;
    }
  });
});

// Suppress unused var warning when vi isn't otherwise used.
void vi;
