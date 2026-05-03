import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { EventStore } from '../src/event-store.js';
import { buildHttpServer, type HttpServerHandle } from '../src/http-server.js';
import { MemoryStore } from '../src/memory-store.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('HTTP server', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let handle: HttpServerHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-http-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    const eventStore = new EventStore(join(dir, 'events'));
    const memoryStore = new MemoryStore(join(dir, 'memory'));
    handle = buildHttpServer({ eventStore, memoryStore, registry });
  });

  afterEach(async () => {
    await handle.close();
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

  it('interventions endpoint returns 202 stub', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'c', title: 'C' });
    const r = await request(handle.app)
      .post('/interventions')
      .send({ workstreamId: 'c', kind: 'nudge', payload: { message: 'hi' } });
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(true);
  });

  it('rejects malformed workstream creates', async () => {
    const r = await request(handle.app).post('/workstreams').send({ id: 'x' });
    expect(r.status).toBe(400);
  });
});
