import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { EventStore } from '../src/event-store.js';
import { buildHttpServer, type HttpServerHandle } from '../src/http-server.js';
import { InterventionQueue } from '../src/intervention-queue.js';
import { MemoryStore } from '../src/memory-store.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('HTTP server', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let interventionQueue: InterventionQueue;
  let handle: HttpServerHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-http-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    const eventStore = new EventStore(join(dir, 'events'));
    const memoryStore = new MemoryStore(join(dir, 'memory'));
    handle = buildHttpServer({ eventStore, memoryStore, registry, interventionQueue });
  });

  afterEach(async () => {
    await handle.close();
    interventionQueue.close();
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
});
