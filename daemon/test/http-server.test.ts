import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventStore } from '../src/event-store.js';
import { HandbookStore } from '../src/handbook-store.js';
import { buildHttpServer, type HttpServerHandle } from '../src/http-server.js';
import { InterventionQueue } from '../src/intervention-queue.js';
import {
  type LLMProvider,
  type LLMProviderName,
  LLMRequestError,
  LLMUnreachableError,
} from '../src/llm/index.js';
import { MemoryStore } from '../src/memory-store.js';
import { ReportStore } from '../src/report-store.js';
import { Scheduler } from '../src/scheduler.js';
import { SettingsStore } from '../src/settings-store.js';
import { SkillProposalsStore } from '../src/skill-proposals.js';
import { WorkstreamLinksStore } from '../src/workstream-links-store.js';
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
  let workstreamLinks: WorkstreamLinksStore;
  let handle: HttpServerHandle;
  let providerCalls: { name: LLMProviderName; system: string; user: string }[];
  let memoryStore: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-http-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
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
    workstreamLinks = new WorkstreamLinksStore(join(dir, 'db.sqlite'));
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
      workstreamLinks,
      linearTrackerFactory: () => ({
        fetchIssueByIdentifier: async (identifier: string) => {
          if (identifier === 'ENG-404') return null;
          return {
            id: `lin_${identifier}`,
            identifier,
            url: `https://linear.app/x/issue/${identifier}`,
            state: 'In Progress',
          };
        },
      }),
      getProvider: fakeProvider,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await handle.close();
    interventionQueue.close();
    skillProposalsStore.close();
    reportStore.close();
    workstreamLinks.close();
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

  it('POST /workstreams/:id/interventions/:intId/answer records choice + emits intervention_delivered', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'q', title: 'Q' });
    const enq = await request(handle.app)
      .post('/interventions')
      .send({
        workstream_id: 'q',
        kind: 'question_required',
        payload: {
          question_request: { question: 'Use cache?', options: ['yes', 'no'] },
        },
      });
    expect(enq.status).toBe(201);
    const intId = enq.body.id as string;

    const ans = await request(handle.app)
      .post(`/workstreams/q/interventions/${intId}/answer`)
      .send({ choice: 'yes' });
    expect(ans.status).toBe(200);
    expect(ans.body.delivered_at).not.toBeNull();
    expect(ans.body.payload.question_answer.choice).toBe('yes');

    // Replay rejected — already answered.
    const replay = await request(handle.app)
      .post(`/workstreams/q/interventions/${intId}/answer`)
      .send({ choice: 'no' });
    expect(replay.status).toBe(409);

    const events = await request(handle.app).get('/workstreams/q/events');
    const delivered = (
      events.body as Array<{ type: string; payload?: Record<string, unknown> }>
    ).filter((e) => e.type === 'intervention_delivered');
    expect(delivered.at(-1)!.payload?.choice).toBe('yes');
  });

  it('POST .../answer rejects choice that does not match options', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'q2', title: 'Q2' });
    const enq = await request(handle.app)
      .post('/interventions')
      .send({
        workstream_id: 'q2',
        kind: 'question_required',
        payload: { question_request: { question: 'Pick', options: ['a', 'b'] } },
      });
    const r = await request(handle.app)
      .post(`/workstreams/q2/interventions/${enq.body.id}/answer`)
      .send({ choice: 'c' });
    expect(r.status).toBe(400);
  });

  it('POST .../answer rejects freetext when allow_freetext is unset', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'q3', title: 'Q3' });
    const enq = await request(handle.app)
      .post('/interventions')
      .send({
        workstream_id: 'q3',
        kind: 'question_required',
        payload: { question_request: { question: 'Pick', options: ['a'] } },
      });
    const r = await request(handle.app)
      .post(`/workstreams/q3/interventions/${enq.body.id}/answer`)
      .send({ freetext: 'something else' });
    expect(r.status).toBe(400);
  });

  it('POST .../answer accepts freetext when allow_freetext was set', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'q4', title: 'Q4' });
    const enq = await request(handle.app)
      .post('/interventions')
      .send({
        workstream_id: 'q4',
        kind: 'question_required',
        payload: {
          question_request: { question: 'Why?', allow_freetext: true },
        },
      });
    const r = await request(handle.app)
      .post(`/workstreams/q4/interventions/${enq.body.id}/answer`)
      .send({ freetext: 'because' });
    expect(r.status).toBe(200);
    expect(r.body.payload.question_answer.freetext).toBe('because');
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

  it('GET /workstreams/:id/adr-material returns decisions ≥0.8 confidence plus memory Markdown', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'adr1', title: 'ADR1' });
    await eventStore.appendEvent('adr1', {
      ts: '2026-05-02T10:00:00Z',
      workstream_id: 'adr1',
      session_id: 's1',
      type: 'decision',
      id: 'dec_high',
      payload: { considered: ['A', 'B'], choice: 'B', rationale: 'because Y', confidence: 0.9 },
    });
    await eventStore.appendEvent('adr1', {
      ts: '2026-05-02T10:05:00Z',
      workstream_id: 'adr1',
      session_id: 's1',
      type: 'decision',
      id: 'dec_low',
      payload: { considered: ['A'], choice: 'A', rationale: 'because X', confidence: 0.4 },
    });
    await memoryStore.updateSection('adr1', 'Current state', 'Migration in progress.');

    const r = await request(handle.app).get('/workstreams/adr1/adr-material');
    expect(r.status).toBe(200);
    expect(r.body.workstream_id).toBe('adr1');
    expect(r.body.min_confidence).toBe(0.8);
    expect(r.body.decisions).toHaveLength(1);
    expect(r.body.decisions[0]).toMatchObject({
      id: 'dec_high',
      choice: 'B',
      rationale: 'because Y',
      confidence: 0.9,
    });
    expect(r.body.memory).toContain('Migration in progress.');
  });

  it('GET /workstreams/:id/adr-material honors a ?min_confidence= override', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'adr2', title: 'ADR2' });
    await eventStore.appendEvent('adr2', {
      ts: '2026-05-02T10:00:00Z',
      workstream_id: 'adr2',
      type: 'decision',
      id: 'dec_mid',
      payload: { considered: [], choice: 'C', rationale: 'r', confidence: 0.5 },
    });
    const r = await request(handle.app).get('/workstreams/adr2/adr-material?min_confidence=0.3');
    expect(r.status).toBe(200);
    expect(r.body.min_confidence).toBe(0.3);
    expect(r.body.decisions).toHaveLength(1);
  });

  it('GET /workstreams/:id/adr-material → 404 for unknown workstream', async () => {
    const r = await request(handle.app).get('/workstreams/missing/adr-material');
    expect(r.status).toBe(404);
  });

  // ---- v1.4.20 orchestrator state enrichment + late binding ---------------

  function fakeOrchestrator(running: Array<{ issue_id: string; identifier: string }>) {
    return {
      snapshot: () => ({
        poll_interval_ms: 5000,
        max_concurrent_agents: 3,
        stall_timeout_ms: 1000,
        counts: { running: running.length, retrying: 0, claimed: 0, completed: 0 },
        running: running.map((r) => ({
          ...r,
          workspace_path: null,
          started_at: '2026-05-02T10:00:00Z',
          attempt: null,
        })),
        retrying: [],
      }),
    };
  }

  it('GET /orchestrator/state is late-bound: a getter that becomes non-null after build is honored', async () => {
    const holder: { current: ReturnType<typeof fakeOrchestrator> | null } = { current: null };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory-orch1')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      get orchestrator() {
        return holder.current ?? undefined;
      },
    } as unknown as Parameters<typeof buildHttpServer>[0]);
    try {
      expect((await request(h2.app).get('/orchestrator/state')).status).toBe(404);
      holder.current = fakeOrchestrator([]);
      const r = await request(h2.app).get('/orchestrator/state');
      expect(r.status).toBe(200);
      expect(r.body.counts.running).toBe(0);
    } finally {
      await h2.close();
    }
  });

  it('GET /orchestrator/state merges tracker/runtime/workflow meta, workstream ids and tmux attach', async () => {
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory-orch2')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      orchestrator: fakeOrchestrator([
        { issue_id: 'proj/feat/phase-1', identifier: 'proj/feat/phase-1' },
        { issue_id: 'ENG-2', identifier: 'ENG-2' },
      ]),
      orchestratorMeta: {
        tracker_kind: 'team-brain',
        agent_runtime: 'claude-code-tmux',
        workflow_path: '/repo/WORKFLOW.fleet.md',
      },
      agentRunner: {
        activeTmuxSessions: () => [
          {
            workstream_id: 'proj_feat_phase-1',
            issue_identifier: 'proj/feat/phase-1',
            session_id: 'sess_abc',
            tmux_session: 'dispatch-proj_feat_phase-1-sess_abc',
            attach_command: 'tmux attach -t dispatch-proj_feat_phase-1-sess_abc',
            started_at: '2026-05-02T10:00:00Z',
          },
        ],
      },
    } as unknown as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app).get('/orchestrator/state');
      expect(r.status).toBe(200);
      expect(r.body.tracker_kind).toBe('team-brain');
      expect(r.body.agent_runtime).toBe('claude-code-tmux');
      expect(r.body.workflow_path).toBe('/repo/WORKFLOW.fleet.md');
      const byId = Object.fromEntries(
        (r.body.running as Array<{ identifier: string }>).map((e) => [e.identifier, e]),
      );
      expect(byId['proj/feat/phase-1']).toMatchObject({
        workstream_id: 'proj_feat_phase-1',
        attach: { command: 'tmux attach -t dispatch-proj_feat_phase-1-sess_abc' },
      });
      expect(byId['ENG-2']).toMatchObject({ workstream_id: 'eng-2', attach: null });
    } finally {
      await h2.close();
    }
  });

  it('workstream wire format carries autonomous_running derived from the orchestrator running set', async () => {
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory-orch3')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      orchestrator: fakeOrchestrator([{ issue_id: 'ENG-7', identifier: 'ENG-7' }]),
    } as unknown as Parameters<typeof buildHttpServer>[0]);
    try {
      await request(h2.app).post('/workstreams').send({ id: 'eng-7', title: 'Seven' });
      await request(h2.app).post('/workstreams').send({ id: 'manual', title: 'Manual' });
      const auto = await request(h2.app).get('/workstreams/eng-7');
      expect(auto.body.autonomous_running).toBe(true);
      const manual = await request(h2.app).get('/workstreams/manual');
      expect(manual.body.autonomous_running).toBe(false);
    } finally {
      await h2.close();
    }
  });

  it('workstream wire format reports autonomous_running=false when no orchestrator is wired', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'plain', title: 'Plain' });
    const r = await request(handle.app).get('/workstreams/plain');
    expect(r.body.autonomous_running).toBe(false);
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

  it('promote also exports to team-brain when teamBrainSkillsDir is configured', async () => {
    const exportImpl = vi
      .fn()
      .mockResolvedValue({ path: '/fake/team-brain/.agents/skills/x/SKILL.md' });
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory-tb1')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      teamBrainSkillsDir: '/fake/team-brain',
      exportSkillToTeamBrainImpl: exportImpl,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      await request(h2.app).post('/workstreams').send({ id: 'sk-tb', title: 'SK TB' });
      const proposal = skillProposalsStore.propose({
        workstream_id: 'sk-tb',
        title: 'Team Brain Pattern',
        body: 'do X then Y',
      });
      const promote = await request(h2.app).post(`/skills/proposed/${proposal.id}/promote`);
      expect(promote.status).toBe(200);
      expect(exportImpl).toHaveBeenCalledWith(
        '/fake/team-brain',
        'Team Brain Pattern',
        'do X then Y',
      );
      expect(promote.body.team_brain_path).toBe('/fake/team-brain/.agents/skills/x/SKILL.md');

      const events = await request(h2.app).get('/workstreams/sk-tb/events');
      const promoted = (
        events.body as Array<{ type: string; payload?: Record<string, unknown> }>
      ).find((e) => e.type === 'skill_promoted');
      expect(promoted?.payload?.['team_brain_path']).toBe(
        '/fake/team-brain/.agents/skills/x/SKILL.md',
      );
    } finally {
      await h2.close();
    }
  });

  it('promote succeeds even when the team-brain export throws (best-effort)', async () => {
    const exportImpl = vi.fn().mockRejectedValue(new Error('disk full'));
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory-tb2')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      teamBrainSkillsDir: '/fake/team-brain',
      exportSkillToTeamBrainImpl: exportImpl,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const proposal = skillProposalsStore.propose({
        workstream_id: 'sk-tb2',
        title: 'Flaky Export',
        body: 'body',
      });
      const promote = await request(h2.app).post(`/skills/proposed/${proposal.id}/promote`);
      expect(promote.status).toBe(200);
      expect(promote.body.status).toBe('promoted');
      expect(promote.body.team_brain_path).toBeUndefined();

      const handbook = await request(h2.app).get('/handbook');
      expect(handbook.text).toContain('## Flaky Export');
    } finally {
      await h2.close();
    }
  });

  it('promote does not attempt team-brain export when teamBrainSkillsDir is absent', async () => {
    const proposal = skillProposalsStore.propose({
      workstream_id: 'sk-tb3',
      title: 'No Team Brain',
      body: 'body',
    });
    const promote = await request(handle.app).post(`/skills/proposed/${proposal.id}/promote`);
    expect(promote.status).toBe(200);
    expect(promote.body.team_brain_path).toBeUndefined();
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

  it('POST /reports/generate maps upstream 4xx (e.g. model not found) → 422', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'r404', title: 'R404' });
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
          throw new LLMRequestError("Local LLM HTTP 404: model 'qwen3:8b' not found", 404);
        },
      }),
    });
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['r404'],
        audience_preset: 'executive',
        provider: 'ollama',
        model: 'qwen3:8b',
      });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('LLM_REQUEST');
    expect(r.body.upstream_status).toBe(404);
    expect(r.body.error).toContain("model 'qwen3:8b' not found");
  });

  it('POST /reports/generate maps upstream 5xx → 502', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'r502', title: 'R502' });
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
          throw new LLMRequestError('Local LLM HTTP 500: out of memory', 500);
        },
      }),
    });
    const r = await request(handle.app)
      .post('/reports/generate')
      .send({
        workstream_ids: ['r502'],
        audience_preset: 'executive',
        provider: 'ollama',
      });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('LLM_REQUEST');
    expect(r.body.upstream_status).toBe(500);
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

  it('GET /settings returns defaults with anthropic + linear keys redacted', async () => {
    // Tests run in a tmp DISPATCH_HOME so the env-var fallback is the only
    // possible source of an API key. Save+restore the key to keep the test
    // hermetic.
    const priorA = process.env['ANTHROPIC_API_KEY'];
    const priorL = process.env['DISPATCH_LINEAR_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['DISPATCH_LINEAR_API_KEY'];
    try {
      const r = await request(handle.app).get('/settings');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        headlineProvider: 'ollama',
        ollamaUrl: 'http://localhost:8080/v1',
        anthropicApiKeyConfigured: false,
        linearApiKeyConfigured: false,
      });
      expect(typeof r.body.headlineModel).toBe('string');
      expect(r.body.anthropicApiKey).toBeUndefined();
      expect(r.body.linearApiKey).toBeUndefined();
    } finally {
      if (priorA !== undefined) process.env['ANTHROPIC_API_KEY'] = priorA;
      if (priorL !== undefined) process.env['DISPATCH_LINEAR_API_KEY'] = priorL;
    }
  });

  it('PATCH /settings persists linearApiKey and redacts on read', async () => {
    const priorL = process.env['DISPATCH_LINEAR_API_KEY'];
    delete process.env['DISPATCH_LINEAR_API_KEY'];
    try {
      const r = await request(handle.app).patch('/settings').send({ linearApiKey: 'lin_api_xxx' });
      expect(r.status).toBe(200);
      expect(r.body.linearApiKeyConfigured).toBe(true);
      expect(r.body.linearApiKey).toBeUndefined();
      expect(settings.getResolvedLinearApiKey()).toBe('lin_api_xxx');

      const cleared = await request(handle.app).patch('/settings').send({ linearApiKey: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.linearApiKeyConfigured).toBe(false);
      expect(settings.getResolvedLinearApiKey()).toBeUndefined();
    } finally {
      if (priorL !== undefined) process.env['DISPATCH_LINEAR_API_KEY'] = priorL;
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
    const r = await request(handle.app).patch('/settings').send({ headlineProvider: 'gpt-99' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/headlineProvider/);
  });

  // ---- Tracker links (v1.2) -----------------------------------------------

  it('GET /workstreams/:id/link returns null when no link exists', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'wl1', title: 'WL1' });
    const r = await request(handle.app).get('/workstreams/wl1/link');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });

  it('PUT /workstreams/:id/link without a Linear key → 503', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'wl2', title: 'WL2' });
    const prior = process.env['DISPATCH_LINEAR_API_KEY'];
    delete process.env['DISPATCH_LINEAR_API_KEY'];
    try {
      const r = await request(handle.app)
        .put('/workstreams/wl2/link')
        .send({ tracker_kind: 'linear', issue_identifier: 'ENG-1' });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('linear_api_key_missing');
    } finally {
      if (prior !== undefined) process.env['DISPATCH_LINEAR_API_KEY'] = prior;
    }
  });

  it('PUT /workstreams/:id/link persists, GET returns it, GET /links lists it', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'wl3', title: 'WL3' });
    await request(handle.app).patch('/settings').send({ linearApiKey: 'lin_test' });

    const put = await request(handle.app)
      .put('/workstreams/wl3/link')
      .send({ tracker_kind: 'linear', issue_identifier: 'ENG-7' });
    expect(put.status).toBe(200);
    expect(put.body.workstream_id).toBe('wl3');
    expect(put.body.issue_identifier).toBe('ENG-7');
    expect(put.body.issue_id).toBe('lin_ENG-7');
    expect(put.body.last_seen_state).toBe('In Progress');

    const got = await request(handle.app).get('/workstreams/wl3/link');
    expect(got.status).toBe(200);
    expect(got.body.issue_identifier).toBe('ENG-7');

    const list = await request(handle.app).get('/links');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(
      (list.body as Array<{ workstream_id: string }>).find((l) => l.workstream_id === 'wl3'),
    ).toBeTruthy();
  });

  it('PUT /workstreams/:id/link with unknown identifier → 400', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'wl4', title: 'WL4' });
    await request(handle.app).patch('/settings').send({ linearApiKey: 'lin_test' });
    const r = await request(handle.app)
      .put('/workstreams/wl4/link')
      .send({ tracker_kind: 'linear', issue_identifier: 'ENG-404' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('linear_unknown_identifier');
  });

  it('DELETE /workstreams/:id/link is idempotent (200 even with no prior link)', async () => {
    await request(handle.app).post('/workstreams').send({ id: 'wl5', title: 'WL5' });
    const r1 = await request(handle.app).delete('/workstreams/wl5/link');
    expect(r1.status).toBe(200);
    // Link, then delete, then delete again — all 200.
    await request(handle.app).patch('/settings').send({ linearApiKey: 'lin_test' });
    await request(handle.app)
      .put('/workstreams/wl5/link')
      .send({ tracker_kind: 'linear', issue_identifier: 'ENG-7' });
    const r2 = await request(handle.app).delete('/workstreams/wl5/link');
    expect(r2.status).toBe(200);
    const r3 = await request(handle.app).delete('/workstreams/wl5/link');
    expect(r3.status).toBe(200);

    const got = await request(handle.app).get('/workstreams/wl5/link');
    expect(got.body).toBeNull();
  });

  it('PUT /workstreams/:id/link on unknown workstream → 404', async () => {
    const r = await request(handle.app)
      .put('/workstreams/no-such/link')
      .send({ tracker_kind: 'linear', issue_identifier: 'ENG-1' });
    expect(r.status).toBe(404);
  });

  // ---- v1.4.11 /trackers/issues ------------------------------------------

  it('POST /trackers/issues 404 when no tracker is wired', async () => {
    const r = await request(handle.app).post('/trackers/issues').send({ title: 'New thing' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('tracker not enabled');
  });

  it('POST /trackers/issues forwards to tracker.createIssue and returns 201', async () => {
    const created: Array<{ title: string }> = [];
    const tracker = {
      kind: 'mock-create',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async createIssue(input: { title: string; description?: string | null }) {
        created.push({ title: input.title });
        return { id: 'i_1', identifier: 'NEW-1', url: 'https://x/1' };
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory2')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app)
        .post('/trackers/issues')
        .send({ title: 'New thing', description: 'body', priority: 2 });
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ id: 'i_1', identifier: 'NEW-1', url: 'https://x/1' });
      expect(created).toEqual([{ title: 'New thing' }]);
    } finally {
      await h2.close();
    }
  });

  it('POST /trackers/issues 400 on missing title', async () => {
    const tracker = {
      kind: 'mock',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async createIssue() {
        return { id: 'x', identifier: 'X-1', url: null };
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory3')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app).post('/trackers/issues').send({});
      expect(r.status).toBe(400);
    } finally {
      await h2.close();
    }
  });

  it('POST /trackers/issues 501 when wired tracker does not implement createIssue', async () => {
    const tracker = {
      kind: 'read-only',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory4')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app).post('/trackers/issues').send({ title: 'Hi' });
      expect(r.status).toBe(501);
      expect(r.body.kind).toBe('read-only');
    } finally {
      await h2.close();
    }
  });

  // ---- v1.4.17 /trackers/transition --------------------------------------

  it('POST /trackers/transition 404 when no tracker is wired', async () => {
    const r = await request(handle.app)
      .post('/trackers/transition')
      .send({ workstream_id: 'ws_1', state: 'Done' });
    expect(r.status).toBe(404);
  });

  it('POST /trackers/transition forwards to tracker.applyTransition + posts comment', async () => {
    const transitions: Array<{ id: string; state: string }> = [];
    const comments: Array<{ id: string; body: string }> = [];
    const tracker = {
      kind: 'mock-tx',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async applyTransition(id: string, state: string) {
        transitions.push({ id, state });
        return state !== 'Bogus';
      },
      async addIssueComment(id: string, body: string) {
        comments.push({ id, body });
        return { id: 'c1' };
      },
    };
    await request(handle.app).post('/workstreams').send({ id: 'ws_tx', title: 'X' });
    workstreamLinks.link({
      workstreamId: 'ws_tx',
      trackerKind: 'linear',
      issueId: 'iss_99',
      issueIdentifier: 'ENG-99',
    });
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory_tx')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app)
        .post('/trackers/transition')
        .send({ workstream_id: 'ws_tx', state: 'Done', comment: 'Shipped via PR #42' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, issue_id: 'iss_99', state: 'Done' });
      expect(transitions).toEqual([{ id: 'iss_99', state: 'Done' }]);
      expect(comments).toEqual([{ id: 'iss_99', body: 'Shipped via PR #42' }]);
    } finally {
      await h2.close();
    }
  });

  it('POST /trackers/transition 422 when state name does not resolve', async () => {
    const tracker = {
      kind: 'mock-tx',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async applyTransition() {
        return false;
      },
    };
    await request(handle.app).post('/workstreams').send({ id: 'ws_tx2', title: 'X' });
    workstreamLinks.link({
      workstreamId: 'ws_tx2',
      trackerKind: 'linear',
      issueId: 'iss_99',
      issueIdentifier: 'ENG-99',
    });
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory_tx2')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app)
        .post('/trackers/transition')
        .send({ workstream_id: 'ws_tx2', state: 'Bogus' });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('state_not_found');
    } finally {
      await h2.close();
    }
  });

  it('POST /trackers/transition 404 when workstream has no tracker link', async () => {
    const tracker = {
      kind: 'mock-tx',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async applyTransition() {
        return true;
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory_tx3')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      const r = await request(h2.app)
        .post('/trackers/transition')
        .send({ workstream_id: 'never-linked', state: 'Done' });
      expect(r.status).toBe(404);
    } finally {
      await h2.close();
    }
  });

  // ---- v1.4.15 file_ticket rate limit -----------------------------------

  it('POST /trackers/issues 429 when fileTicketMaxPerHour is exceeded', async () => {
    let now = 1_000_000;
    const tracker = {
      kind: 'mock-rl',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async createIssue() {
        return { id: 'i', identifier: 'M-1', url: null };
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory_rl')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
      fileTicketMaxPerHour: 2,
      fileTicketClock: () => now,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      // First two land.
      expect((await request(h2.app).post('/trackers/issues').send({ title: 'a' })).status).toBe(
        201,
      );
      expect((await request(h2.app).post('/trackers/issues').send({ title: 'b' })).status).toBe(
        201,
      );
      // Third trips the limit.
      const r3 = await request(h2.app).post('/trackers/issues').send({ title: 'c' });
      expect(r3.status).toBe(429);
      expect(r3.body.code).toBe('file_ticket_rate_limited');
      expect(r3.body.limit).toBe(2);
      expect(r3.body.retry_after_ms).toBeGreaterThan(0);
      // Wind clock past the window — the first two evict, third now lands.
      now += 60 * 60 * 1000 + 1;
      const r4 = await request(h2.app).post('/trackers/issues').send({ title: 'd' });
      expect(r4.status).toBe(201);
    } finally {
      await h2.close();
    }
  });

  it('POST /trackers/issues failed tracker writes do NOT count against the rate limit', async () => {
    const tracker = {
      kind: 'mock-fail',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async createIssue() {
        throw new Error('linear down');
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory_rl_fail')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
      fileTicketMaxPerHour: 1,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      // 5 failed createIssue calls — each comes back 500 but none consume
      // a slot, so a subsequent (still-failing) call still gets through to
      // tracker rather than hitting 429.
      for (let i = 0; i < 5; i++) {
        const r = await request(h2.app)
          .post('/trackers/issues')
          .send({ title: `t${i}` });
        expect(r.status).toBe(500);
      }
    } finally {
      await h2.close();
    }
  });

  it('POST /trackers/issues with fileTicketMaxPerHour=0 disables the limit', async () => {
    const tracker = {
      kind: 'mock-no-rl',
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map<string, string>();
      },
      async createIssue() {
        return { id: 'i', identifier: 'M-1', url: null };
      },
    };
    const h2 = buildHttpServer({
      eventStore,
      memoryStore: new MemoryStore(join(dir, 'memory_no_rl')),
      registry,
      interventionQueue,
      handbookStore,
      skillProposalsStore,
      reportStore,
      scheduler,
      settings,
      workstreamLinks,
      tracker,
      fileTicketMaxPerHour: 0,
    } as Parameters<typeof buildHttpServer>[0]);
    try {
      // 50 calls, all 201.
      for (let i = 0; i < 50; i++) {
        const r = await request(h2.app)
          .post('/trackers/issues')
          .send({ title: `t${i}` });
        expect(r.status).toBe(201);
      }
    } finally {
      await h2.close();
    }
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

describe('HTTP server admin endpoints (v1.4.6 Diagnostics)', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let interventionQueue: InterventionQueue;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let handbookStore: HandbookStore;
  let skillProposalsStore: SkillProposalsStore;
  let reportStore: ReportStore;
  let scheduler: Scheduler;
  let settings: SettingsStore;
  let workstreamLinks: WorkstreamLinksStore;
  let handle: HttpServerHandle;
  let pidLookups: number[];
  let killCalls: number[];
  let spawnCalls: string[];
  let pidsToReturn: number[];
  let escalateNext: boolean;
  let spawnNext: { ok: boolean; pid?: number; error?: string };
  let restartCalls: number;
  let restartedNames: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-admin-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    handbookStore = new HandbookStore(join(dir, 'handbook.md'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    reportStore = new ReportStore(join(dir, 'db.sqlite'));
    scheduler = new Scheduler(
      { registry, eventStore, memoryStore, reportStore },
      join(dir, 'scheduler.json'),
    );
    await scheduler.start();
    settings = new SettingsStore(join(dir, 'settings.json'));
    workstreamLinks = new WorkstreamLinksStore(join(dir, 'db.sqlite'));

    pidLookups = [];
    killCalls = [];
    spawnCalls = [];
    pidsToReturn = [];
    escalateNext = false;
    spawnNext = { ok: true, pid: 99999 };
    restartCalls = 0;
    restartedNames = ['headliner', 'subgoal_synth', 'linear_sync'];

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
      workstreamLinks,
      adminImpls: {
        findPidOnPort: async (port) => {
          pidLookups.push(port);
          return [...pidsToReturn];
        },
        killWithEscalation: async (pid) => {
          killCalls.push(pid);
          return { escalated: escalateNext, dead: true };
        },
        spawnDetached: async (cmd) => {
          spawnCalls.push(cmd);
          return spawnNext;
        },
      },
      tickerRestarter: () => {
        restartCalls += 1;
        return restartedNames;
      },
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await handle.close();
    interventionQueue.close();
    skillProposalsStore.close();
    reportStore.close();
    workstreamLinks.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('POST /admin/llm/kill returns null when nothing is listening', async () => {
    pidsToReturn = [];
    const r = await request(handle.app).post('/admin/llm/kill');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ killed: null, escalated: false });
    // The configured base URL is the SettingsStore default = port 8080.
    expect(pidLookups).toEqual([8080]);
    expect(killCalls).toEqual([]);
  });

  it('POST /admin/llm/kill kills the listener PID and surfaces escalation flag', async () => {
    pidsToReturn = [4242];
    escalateNext = true;
    const r = await request(handle.app).post('/admin/llm/kill');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ killed: 4242, escalated: true });
    expect(killCalls).toEqual([4242]);
  });

  it('POST /admin/llm/kill resolves a custom URL from settings', async () => {
    await request(handle.app).patch('/settings').send({ ollamaUrl: 'http://localhost:11434/v1' });
    pidsToReturn = [];
    await request(handle.app).post('/admin/llm/kill');
    expect(pidLookups).toEqual([11434]);
  });

  it('POST /admin/llm/restart 400s with no_start_command when unset', async () => {
    const r = await request(handle.app).post('/admin/llm/restart');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('no_start_command');
    expect(spawnCalls).toEqual([]);
  });

  it('POST /admin/llm/restart kills + spawns when configured', async () => {
    await request(handle.app)
      .patch('/settings')
      .send({ localLLMStartCommand: 'mlx_lm.server --port 8080' });
    pidsToReturn = [4242];

    const r = await request(handle.app).post('/admin/llm/restart');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ killed_pid: 4242, started: true });
    expect(killCalls).toEqual([4242]);
    expect(spawnCalls).toEqual(['mlx_lm.server --port 8080']);
  });

  it('POST /admin/llm/restart returns killed_pid:null when nothing was running', async () => {
    await request(handle.app)
      .patch('/settings')
      .send({ localLLMStartCommand: 'mlx_lm.server --port 8080' });
    pidsToReturn = [];

    const r = await request(handle.app).post('/admin/llm/restart');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ killed_pid: null, started: true });
    expect(killCalls).toEqual([]);
    expect(spawnCalls).toEqual(['mlx_lm.server --port 8080']);
  });

  it('POST /admin/llm/restart 500s when spawn fails', async () => {
    await request(handle.app).patch('/settings').send({ localLLMStartCommand: 'bogus-bin' });
    spawnNext = { ok: false, error: 'ENOENT' };

    const r = await request(handle.app).post('/admin/llm/restart');
    expect(r.status).toBe(500);
    expect(r.body.started).toBe(false);
    expect(r.body.error).toContain('ENOENT');
  });

  it('POST /admin/restart invokes the restarter and returns the list', async () => {
    const r = await request(handle.app).post('/admin/restart');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ restarted: ['headliner', 'subgoal_synth', 'linear_sync'] });
    expect(restartCalls).toBe(1);
  });

  it('POST /admin/restart 500s when the restarter throws', async () => {
    await handle.close();
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
      workstreamLinks,
      tickerRestarter: () => {
        throw new Error('boom');
      },
    });
    const r = await request(handle.app).post('/admin/restart');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('boom');
  });

  it('POST /admin/restart 404s when no tickerRestarter is wired', async () => {
    await handle.close();
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
      workstreamLinks,
    });
    const r = await request(handle.app).post('/admin/restart');
    expect(r.status).toBe(404);
  });

  it('GET /settings exposes localLLMStartCommand', async () => {
    await request(handle.app)
      .patch('/settings')
      .send({ localLLMStartCommand: 'mlx_lm.server --port 8080' });
    const r = await request(handle.app).get('/settings');
    expect(r.body.localLLMStartCommand).toBe('mlx_lm.server --port 8080');
  });

  // ---- v1.4.13 /admin/llm/pull-model -------------------------------------

  it('POST /admin/llm/pull-model 400 when model is missing', async () => {
    const r = await request(handle.app).post('/admin/llm/pull-model').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('model is required');
  });

  it('POST /admin/llm/pull-model forwards to pullOllamaModel and returns its result', async () => {
    await handle.close();
    let capturedModel = '';
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
      workstreamLinks,
      adminImpls: {
        pullOllamaModel: async (model) => {
          capturedModel = model;
          return { ok: true, exit_code: 0, output: 'success\n' };
        },
      },
    });
    const r = await request(handle.app).post('/admin/llm/pull-model').send({ model: 'qwen3:8b' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, exit_code: 0, output: 'success\n' });
    expect(capturedModel).toBe('qwen3:8b');
  });

  it('POST /admin/llm/pull-model returns 200 with ok:false on a clean non-zero exit', async () => {
    await handle.close();
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
      workstreamLinks,
      adminImpls: {
        pullOllamaModel: async () => ({
          ok: false,
          exit_code: 1,
          output: 'Error: model not found\n',
        }),
      },
    });
    const r = await request(handle.app).post('/admin/llm/pull-model').send({ model: 'qwen3:8b' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.output).toContain('model not found');
  });
});

// Suppress unused var warning when vi isn't otherwise used.
void vi;
