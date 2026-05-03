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

    const hook = await request(handle.app)
      .post('/hooks/session-start')
      .send({ workstream: 'demo', session: 'sess-abc', cwd: '/tmp' });
    expect(hook.status).toBe(202);

    const events = await request(handle.app).get('/workstreams/demo/events');
    expect(events.status).toBe(200);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0].type).toBe('session_start');
    expect(events.body.events[0].workstream_id).toBe('demo');
    expect(events.body.events[0].session_id).toBe('sess-abc');
    expect(events.body.events[0].payload.hook).toBe('session-start');
    expect(events.body.events[0].payload.cwd).toBe('/tmp');
  });

  it('returns 404 for unknown workstream', async () => {
    const r = await request(handle.app).get('/workstreams/missing');
    expect(r.status).toBe(404);
    const e = await request(handle.app).get('/workstreams/missing/events');
    expect(e.status).toBe(404);
  });

  it('lists workstreams and exposes detail with sessions', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'a', title: 'A' });
    await request(handle.app).post('/hooks/session-start').send({ workstream: 'a', session: 's1' });

    const list = await request(handle.app).get('/workstreams');
    expect(list.status).toBe(200);
    expect(list.body.workstreams).toHaveLength(1);

    const detail = await request(handle.app).get('/workstreams/a');
    expect(detail.status).toBe(200);
    expect(detail.body.workstream.id).toBe('a');
    expect(detail.body.workstream.sessions).toHaveLength(1);
    expect(detail.body.workstream.sessions[0].sessionId).toBe('s1');
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
