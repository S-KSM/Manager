import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventStore, ManagerEvent, ManagerEventType } from './event-store.js';
import type {
  InterventionKind,
  InterventionPayload,
  InterventionQueue,
} from './intervention-queue.js';
import type { MemoryStore } from './memory-store.js';
import { projectFromEvents } from './projections.js';
import type { Workstream, WorkstreamRegistry, WorkstreamWithSessions } from './workstream.js';

interface BuildOptions {
  eventStore: EventStore;
  memoryStore: MemoryStore;
  registry: WorkstreamRegistry;
  interventionQueue: InterventionQueue;
}

const INTERVENTION_KINDS: ReadonlySet<InterventionKind> = new Set([
  'nudge',
  'redirect',
  'rollback',
]);

/**
 * Hooks intake: each `/hooks/<event>` endpoint accepts a JSON payload and
 * translates it into a typed `ManagerEvent` appended to the per-workstream
 * JSONL store. Hooks supply `workstream` and `session` fields; everything
 * else lands in the event payload.
 */
const HOOK_TYPE_MAP: Record<string, ManagerEventType> = {
  'session-start': 'session_start',
  stop: 'session_end',
  'pre-tool-use': 'tool_use',
  'post-tool-use': 'tool_use',
  'user-prompt-submit': 'tool_use',
};

interface HookBody {
  workstream?: string;
  session?: string;
  [k: string]: unknown;
}

export interface HttpServerHandle {
  app: Express;
  httpServer: HttpServer;
  wss: WebSocketServer;
  /** Listen on the given port. Returns the actual port (useful when port=0). */
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
}

export function buildHttpServer(opts: BuildOptions): HttpServerHandle {
  const { eventStore, memoryStore, registry, interventionQueue } = opts;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  /**
   * Wire-format Workstream as documented in docs/ARCHITECTURE.md (snake_case),
   * including the home-view projection fields.
   *
   * v0.5.1 computes `current_subgoal`, `latest_confidence`, and
   * `needs_attention` by reading the workstream's events file and folding
   * it through `projectFromEvents`. This re-reads the JSONL on every
   * `GET /workstreams[/:id]` request — acceptable for v0/v0.5 file sizes
   * (single-digit MB at worst). v1 will move these projections behind a
   * SQLite index that is updated incrementally on append.
   */
  async function serializeWorkstream(
    ws: Workstream | WorkstreamWithSessions,
  ): Promise<Record<string, unknown>> {
    const sessionIds: string[] = 'sessions' in ws ? ws.sessions.map((s) => s.sessionId) : [];
    const lastEventAt = await eventStore.lastActivityAt(ws.id);
    const { events } = await eventStore.readEvents(ws.id);
    const projections = projectFromEvents(events);
    return {
      workstream_id: ws.id,
      title: ws.title,
      status: ws.status,
      created_at: ws.createdAt,
      memory_path: memoryStore.pathFor(ws.id),
      sessions: sessionIds,
      current_subgoal: projections.current_subgoal,
      latest_confidence: projections.latest_confidence,
      needs_attention: projections.needs_attention,
      last_event_at: lastEventAt,
    };
  }

  // ---- Health --------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ---- Workstreams ---------------------------------------------------------

  app.get('/workstreams', async (_req: Request, res: Response) => {
    const workstreams = await Promise.all(registry.list().map(serializeWorkstream));
    res.json(workstreams);
  });

  app.post('/workstreams', async (req: Request, res: Response) => {
    const body = req.body as { id?: string; title?: string };
    if (!body?.id || !body?.title) {
      res.status(400).json({ error: 'id and title required' });
      return;
    }
    const existing = registry.get(body.id);
    if (existing) {
      res
        .status(409)
        .json({ error: 'workstream exists', workstream: await serializeWorkstream(existing) });
      return;
    }
    const ws = registry.create(body.id, body.title);
    res.status(201).json(await serializeWorkstream(ws));
  });

  app.get('/workstreams/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const detail = registry.detail(id);
    if (!detail) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(await serializeWorkstream(detail));
  });

  app.get('/workstreams/:id/memory', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const md = await memoryStore.read(id);
    res.type('text/markdown').send(md);
  });

  app.get('/workstreams/:id/events', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const since = req.query['since'];
    const sinceOffset = typeof since === 'string' ? Number.parseInt(since, 10) : 0;
    const result = await eventStore.readEvents(id, Number.isFinite(sinceOffset) ? sinceOffset : 0);
    res.json(result.events);
  });

  /**
   * Decision lookup by id. Returns the full event envelope
   * (`ts`, `workstream_id`, `session_id`, `parent_id`, `payload`) for the
   * `decision` event whose `id` matches. 404 for unknown workstream or
   * unknown decision id.
   */
  app.get('/workstreams/:id/decisions/:decisionId', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const decisionId = String(req.params['decisionId']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { events } = await eventStore.readEvents(id);
    const match = events.find((e) => e.type === 'decision' && e.id === decisionId);
    if (!match) {
      res.status(404).json({ error: 'decision not found' });
      return;
    }
    res.json(match);
  });

  // ---- Hooks ---------------------------------------------------------------

  for (const [hook, type] of Object.entries(HOOK_TYPE_MAP)) {
    app.post(`/hooks/${hook}`, async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as HookBody;
      const workstreamId = String(body.workstream ?? process.env.MANAGER_WORKSTREAM ?? 'default');
      const sessionId = body.session ? String(body.session) : undefined;
      registry.ensure(workstreamId);
      if (type === 'session_start' && sessionId) {
        registry.startSession(sessionId, workstreamId);
      } else if (type === 'session_end' && sessionId) {
        registry.endSession(sessionId);
      }
      // payload = body without workstream/session
      const { workstream: _w, session: _s, ...rest } = body;
      void _w;
      void _s;
      const event: ManagerEvent = {
        ts: new Date().toISOString(),
        workstream_id: workstreamId,
        session_id: sessionId,
        type,
        id: `${type}_${randomUUID().slice(0, 8)}`,
        payload: { hook, ...rest },
      };
      await eventStore.appendEvent(workstreamId, event);
      res.status(202).json({ accepted: true, event_id: event.id });
    });
  }

  // ---- Interventions -------------------------------------------------------

  app.post('/interventions', (req: Request, res: Response) => {
    // Wire format is snake_case (`workstream_id`); the v0 stub used camelCase
    // (`workstreamId`). Accept either for one release as backwards-compat;
    // clients should migrate to snake_case to match every other endpoint.
    const body = (req.body ?? {}) as {
      workstream_id?: unknown;
      workstreamId?: unknown;
      kind?: unknown;
      payload?: unknown;
    };
    const workstreamId =
      typeof body.workstream_id === 'string' && body.workstream_id
        ? body.workstream_id
        : typeof body.workstreamId === 'string' && body.workstreamId
          ? body.workstreamId
          : '';
    const kind = typeof body.kind === 'string' ? body.kind : '';
    if (!workstreamId) {
      res.status(400).json({ error: 'workstream_id required' });
      return;
    }
    if (!INTERVENTION_KINDS.has(kind as InterventionKind)) {
      res.status(400).json({ error: 'kind must be one of nudge, redirect, rollback' });
      return;
    }
    if (!registry.get(workstreamId)) {
      res.status(404).json({ error: 'workstream not found' });
      return;
    }
    const payload =
      body.payload && typeof body.payload === 'object'
        ? (body.payload as InterventionPayload)
        : ({} as InterventionPayload);
    if (kind === 'rollback' && !payload.rollback_to_decision_id) {
      res.status(400).json({ error: 'payload.rollback_to_decision_id required for rollback' });
      return;
    }
    const intervention = interventionQueue.enqueue(workstreamId, kind as InterventionKind, payload);
    res.status(201).json(intervention);
  });

  app.get('/workstreams/:id/interventions/pending', (req: Request, res: Response) => {
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(interventionQueue.listPending(id));
  });

  app.post('/workstreams/:id/interventions/ack', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    const ids = body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array of strings' });
      return;
    }
    const updated = interventionQueue.ackDelivered(ids);
    for (const intv of updated) {
      const eventPayload: Record<string, unknown> = {
        intervention_id: intv.id,
        kind: intv.kind,
      };
      if (intv.payload.message !== undefined) {
        eventPayload['message'] = intv.payload.message;
      }
      if (intv.payload.rollback_to_decision_id !== undefined) {
        eventPayload['rollback_to_decision_id'] = intv.payload.rollback_to_decision_id;
      }
      const event: ManagerEvent = {
        ts: intv.delivered_at ?? new Date().toISOString(),
        workstream_id: intv.workstream_id,
        type: 'intervention_delivered',
        id: `intd_${randomUUID().slice(0, 8)}`,
        payload: eventPayload,
      };
      await eventStore.appendEvent(intv.workstream_id, event);
    }
    res.json(updated);
  });

  // ---- WebSocket: live event stream ---------------------------------------

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    const m = /^\/workstreams\/([^/]+)\/events\/stream(?:\?(.*))?$/.exec(url);
    if (!m) {
      socket.destroy();
      return;
    }
    const workstreamId = decodeURIComponent(m[1]!);
    const querystring = m[2] ?? '';
    const params = new URLSearchParams(querystring);
    const since = Number.parseInt(params.get('since') ?? '0', 10);
    if (!registry.get(workstreamId)) {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      void streamEvents(ws, eventStore, workstreamId, Number.isFinite(since) ? since : 0);
    });
  });

  return {
    app,
    httpServer,
    wss,
    listen: (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (e: Error): void => reject(e);
        httpServer.once('error', onError);
        httpServer.listen(port, () => {
          httpServer.off('error', onError);
          const addr = httpServer.address();
          if (addr && typeof addr === 'object') resolve(addr.port);
          else resolve(port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) {
          c.terminate();
        }
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      }),
  };
}

async function streamEvents(
  ws: WebSocket,
  store: EventStore,
  workstreamId: string,
  sinceOffset: number,
): Promise<void> {
  // Replay history first.
  const initial = await store.readEvents(workstreamId, sinceOffset);
  for (const ev of initial.events) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(ev));
    }
  }
  const tail = store.tailEvents(workstreamId, initial.nextOffset, (ev) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(ev));
    }
  });
  ws.on('close', () => tail.close());
  ws.on('error', () => tail.close());
}
