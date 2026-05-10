import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  findPidOnPort as defaultFindPidOnPort,
  killWithEscalation as defaultKillWithEscalation,
  parseHostPort,
  pullOllamaModel as defaultPullOllamaModel,
  spawnDetached as defaultSpawnDetached,
} from './admin.js';
import { buildDigest } from './digest.js';
import type { EventStore, ManagerEvent, ManagerEventType } from './event-store.js';
import type { HandbookStore, SkillSource } from './handbook-store.js';
import type { HeadlineStore } from './headline-store.js';
import type {
  InterventionKind,
  InterventionPayload,
  InterventionQueue,
} from './intervention-queue.js';
import {
  type LLMProvider,
  type LLMProviderName,
  type ProviderOverrides,
  LLMConfigError,
  LLMRequestError,
  LLMUnreachableError,
  getProvider as defaultGetProvider,
} from './llm/index.js';
import type { MemoryStore } from './memory-store.js';
import type { Orchestrator } from './orchestrator.js';
import type { SettingsStore } from './settings-store.js';
import { projectFromEvents } from './projections.js';
import { assembleReport } from './report-engine.js';
import { renderUserPrompt } from './report-prompt.js';
import { PRESETS, getPreset, resolveSystemPrompt } from './report-presets.js';
import type { ReportStatus, ReportStore } from './report-store.js';
import type { Scheduler, SchedulerJobUpdate } from './scheduler.js';
import type { SkillProposalsStore } from './skill-proposals.js';
import type {
  Workstream,
  WorkstreamRegistry,
  WorkstreamStatus,
  WorkstreamWithSessions,
} from './workstream.js';
import type { WorkstreamLinksStore } from './workstream-links-store.js';
import { LinearTracker } from './trackers/linear.js';
import { type Tracker, TrackerError } from './trackers/index.js';

interface BuildOptions {
  eventStore: EventStore;
  memoryStore: MemoryStore;
  registry: WorkstreamRegistry;
  interventionQueue: InterventionQueue;
  handbookStore: HandbookStore;
  skillProposalsStore: SkillProposalsStore;
  reportStore: ReportStore;
  scheduler: Scheduler;
  /** Optional in-memory store of LLM-generated activity headlines. */
  headlineStore?: HeadlineStore;
  /** Optional orchestrator (v1.4+). When absent, /orchestrator/state returns 404. */
  orchestrator?: Orchestrator;
  /**
   * v1.4.11 — Long-lived `Tracker` instance the daemon already constructed
   * for the orchestrator. When present, `POST /trackers/issues` is served
   * (route 501s if `tracker.createIssue` isn't implemented). Absent =
   * endpoint 404s with `{error: "tracker not enabled"}`.
   */
  tracker?: Tracker;
  /**
   * v1.4.15 — Per-process rate limit on `POST /trackers/issues` (and
   * therefore on the `dispatch__file_ticket` MCP tool that wraps it). 0
   * disables. Default 30/hour. Tuned for the triage-agent path: a runaway
   * agent looping `file_ticket` should hit the wall before it spams Linear.
   */
  fileTicketMaxPerHour?: number;
  /** Test seam — clock injector for the rate limiter. */
  fileTicketClock?: () => number;
  /**
   * Persisted user-editable LLM settings. When present:
   *   - `GET /settings` and `PATCH /settings` are served (404 otherwise),
   *   - `/reports/generate` reads the stored API key + Ollama URL when the
   *     caller doesn't override them per-request.
   */
  settings?: SettingsStore;
  /** Override the LLM provider factory; used by tests to inject mocks. */
  getProvider?: (name: LLMProviderName, overrides?: ProviderOverrides) => LLMProvider;
  /**
   * v1.2 tracker-link store. When present, `/workstreams/:id/link` and
   * `/links` are served and the optional Linear sync ticker can find rows.
   * When absent the link endpoints 404 with `{error: "links not enabled"}`.
   */
  workstreamLinks?: WorkstreamLinksStore;
  /**
   * Test-only override for the LinearTracker constructor — lets us inject a
   * mock fetch without standing up a real Linear endpoint. When absent,
   * production wiring uses `new LinearTracker({apiKey, projectSlug})`.
   */
  linearTrackerFactory?: (apiKey: string) => {
    fetchIssueByIdentifier: (
      identifier: string,
    ) => Promise<{ id: string; identifier: string; url: string | null; state: string } | null>;
  };
  /**
   * v1.4.6 — callback that the `POST /admin/restart` endpoint invokes to
   * cancel + re-instantiate the daemon's tickers (Headliner /
   * SubgoalSynthesizer / LinearCommentSyncer) so a Settings change takes
   * effect without process exit. Returns the list of restarted ticker
   * names. When absent, the endpoint 404s.
   *
   * The supervisor lives in `cli.ts` (it owns the constructed instances);
   * we pass only a callback so http-server.ts stays free of ticker
   * construction details.
   */
  tickerRestarter?: () => string[];
  /**
   * v1.4.6 test seam — override the admin helpers for `/admin/llm/*` so
   * the http-server tests don't actually shell out to lsof / spawn a
   * real `bash`. Production wiring leaves these undefined, which falls
   * back to the real `./admin.js` helpers.
   */
  adminImpls?: {
    findPidOnPort?: (port: number) => Promise<number[]>;
    killWithEscalation?: (pid: number) => Promise<{ escalated: boolean; dead: boolean }>;
    spawnDetached?: (cmd: string) => Promise<{ ok: boolean; pid?: number; error?: string }>;
    /**
     * v1.4.13 test seam — override `pullOllamaModel` so http-server tests
     * don't actually shell out to `ollama pull <gigs>`. Returns the same
     * shape as the real helper.
     */
    pullOllamaModel?: (
      model: string,
    ) => Promise<{ ok: boolean; exit_code: number | null; output: string; error?: string }>;
  };
}

const VALID_REPORT_STATUSES: ReadonlySet<ReportStatus> = new Set(['draft', 'saved', 'archived']);
const VALID_PROVIDERS: ReadonlySet<LLMProviderName> = new Set(['claude', 'ollama']);
const REPORT_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const WORKSTREAM_STATUSES: ReadonlySet<WorkstreamStatus> = new Set([
  'backlog',
  'active',
  'paused',
  'retired',
]);

const DIGEST_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const INTERVENTION_KINDS: ReadonlySet<InterventionKind> = new Set([
  'nudge',
  'redirect',
  'rollback',
  'approval_required',
  'question_required',
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
  const {
    eventStore,
    memoryStore,
    registry,
    interventionQueue,
    handbookStore,
    skillProposalsStore,
    reportStore,
    scheduler,
    headlineStore,
    orchestrator,
    settings,
    workstreamLinks,
    tickerRestarter,
    tracker,
  } = opts;
  const getProvider = opts.getProvider ?? defaultGetProvider;
  const linearTrackerFactory =
    opts.linearTrackerFactory ??
    ((apiKey: string) => new LinearTracker({ apiKey, projectSlug: 'unused-for-link-flow' }));
  const adminFindPidOnPort = opts.adminImpls?.findPidOnPort ?? defaultFindPidOnPort;
  const adminKillWithEscalation =
    opts.adminImpls?.killWithEscalation ?? ((pid: number) => defaultKillWithEscalation(pid));
  const adminSpawnDetached =
    opts.adminImpls?.spawnDetached ?? ((cmd: string) => defaultSpawnDetached(cmd));
  const adminPullOllamaModel =
    opts.adminImpls?.pullOllamaModel ?? ((model: string) => defaultPullOllamaModel(model));
  // v1.4.15 — file_ticket rate limiter. Hard-cap 0 disables the check;
  // negative falls through to the default 30/hour.
  const fileTicketMaxPerHour =
    opts.fileTicketMaxPerHour !== undefined && opts.fileTicketMaxPerHour >= 0
      ? opts.fileTicketMaxPerHour
      : 30;
  const fileTicketClock = opts.fileTicketClock ?? Date.now;
  const fileTicketTimestamps: number[] = [];
  const FILE_TICKET_WINDOW_MS = 60 * 60 * 1000;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  /**
   * Wire-format Workstream as documented in docs/ARCHITECTURE.md (snake_case),
   * including the home-view projection fields.
   *
   * v0.5.1 computes `current_subgoal`, `latest_confidence`, and
   * `needs_attention` by reading the workstream's events file and folding
   * it through `projectFromEvents`. v1.2 adds `todos` (latest TodoWrite
   * tool_use's todo array) and `latest_activity` (humanized last tool_use)
   * so the home card can show a "Currently: …" line when the agent isn't
   * calling `emit_subgoal`. All five projections re-read the JSONL on every
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
    const headline = headlineStore?.get(ws.id) ?? null;
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
      todos: projections.todos,
      latest_activity: projections.latest_activity,
      live_session: projections.live_session,
      activity_headline: headline?.text ?? null,
      activity_headline_at: headline?.generatedAt ?? null,
      last_event_at: lastEventAt,
    };
  }

  // ---- Health --------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ---- Settings (v1.5: surface LLM provider config in macOS Settings) ------

  /**
   * Read user-editable LLM settings. The Anthropic API key is redacted to a
   * boolean (`anthropicApiKeyConfigured`) — clients never see the value, even
   * one they themselves wrote, since it's a sensitive credential.
   *
   * Returns 404 when the daemon was built without a SettingsStore (test harness
   * scenarios). Production always wires it.
   */
  app.get('/settings', (_req: Request, res: Response) => {
    if (!settings) {
      res.status(404).json({ error: 'settings store not enabled' });
      return;
    }
    res.json(settings.serializeForWire());
  });

  /**
   * Apply a partial settings patch and persist. Body shape mirrors the wire
   * GET shape, but `anthropicApiKey` (the cleartext key) is accepted as a
   * write-only field — pass an empty string to clear it.
   *
   * Validation lives in `SettingsStore.patch`; on bad input we surface the
   * thrown error message as a 400 so the macOS Settings UI can render it
   * verbatim. The 200 response is the redacted wire shape, matching GET.
   */
  app.patch('/settings', (req: Request, res: Response) => {
    if (!settings) {
      res.status(404).json({ error: 'settings store not enabled' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      settings.patch(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    res.json(settings.serializeForWire());
  });

  // ---- Admin: kill / restart (v1.4.6 Diagnostics tab) ---------------------

  /**
   * Kill the local LLM server. Resolves the configured base URL via the same
   * env > settings > default chain SettingsStore uses, extracts the host:port,
   * finds the listener PID via `lsof`, and SIGTERMs it (with a 3-second
   * grace period before SIGKILL).
   *
   * Always returns 200. The body distinguishes between "nothing to kill"
   * (`killed: null`) and a successful kill (`killed: <pid>`). `escalated`
   * is true when SIGTERM didn't take and we had to SIGKILL.
   */
  app.post('/admin/llm/kill', async (_req: Request, res: Response) => {
    const baseUrl = settings?.getResolvedOllamaUrl() ?? 'http://localhost:8080/v1';
    const parsed = parseHostPort(baseUrl);
    if (!parsed) {
      res.status(200).json({
        killed: null,
        escalated: false,
        error: `could not parse base URL: ${baseUrl}`,
      });
      return;
    }
    let pids: number[];
    try {
      pids = await adminFindPidOnPort(parsed.port);
    } catch (err) {
      res.status(200).json({
        killed: null,
        escalated: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (pids.length === 0) {
      res.status(200).json({ killed: null, escalated: false });
      return;
    }
    // Multiple PIDs on a port should be rare (it's a TCP listener) but lsof
    // can return both the listener and forks of it. Just nuke the first one
    // we found — the listener PID is normally first.
    const pid = pids[0] as number;
    const outcome = await adminKillWithEscalation(pid);
    res.status(200).json({ killed: pid, escalated: outcome.escalated });
  });

  /**
   * Kill, then spawn `localLLMStartCommand` via `bash -lc` detached. The
   * detach + `unref()` make sure the daemon can keep running independent of
   * the new server's lifecycle.
   *
   * 400 with `code: 'no_start_command'` when the user hasn't configured a
   * command yet — the macOS UI uses that to render a tooltip.
   */
  app.post('/admin/llm/restart', async (_req: Request, res: Response) => {
    const command = settings?.getLocalLLMStartCommand() ?? '';
    if (command.length === 0) {
      res.status(400).json({
        error: 'localLLMStartCommand is not configured',
        code: 'no_start_command',
      });
      return;
    }

    // Kill phase. Don't fail the whole request if the kill flow can't find a
    // PID — the spawn might be the user's first launch, in which case there's
    // nothing to kill.
    let killedPid: number | null = null;
    const baseUrl = settings?.getResolvedOllamaUrl() ?? 'http://localhost:8080/v1';
    const parsed = parseHostPort(baseUrl);
    if (parsed) {
      try {
        const pids = await adminFindPidOnPort(parsed.port);
        if (pids.length > 0) {
          const pid = pids[0] as number;
          await adminKillWithEscalation(pid);
          killedPid = pid;
        }
      } catch {
        // Treat lsof failures as "nothing was listening".
      }
    }

    const spawnResult = await adminSpawnDetached(command);
    if (!spawnResult.ok) {
      res.status(500).json({
        killed_pid: killedPid,
        started: false,
        error: spawnResult.error ?? 'spawn failed',
      });
      return;
    }
    res.status(200).json({ killed_pid: killedPid, started: true });
  });

  /**
   * v1.4.13 — Pull a model into the local LLM runtime. Body: `{model}`.
   * Synchronous: waits for `ollama pull <model>` to finish before responding
   * so the UI can show a final state. Returns `{ok, exit_code, output,
   * error?}`. Validates the model name pattern at the helper level. 400 on
   * missing model; 200 with `ok=false` on a clean run that returned non-zero
   * (e.g. unknown model, no network) so the UI can show the tail of the
   * pull's output without treating the request itself as failed.
   */
  app.post('/admin/llm/pull-model', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    const result = await adminPullOllamaModel(model);
    res.status(200).json(result);
  });

  /**
   * Soft-restart: cancel + re-instantiate the daemon's background tickers
   * so a Settings change takes effect without exiting the process. Hard
   * restart (full daemon respawn) is handled client-side via
   * `launchctl kickstart -k` — the daemon couldn't respond to its own
   * shutdown anyway.
   */
  app.post('/admin/restart', (_req: Request, res: Response) => {
    if (!tickerRestarter) {
      res.status(404).json({ error: 'ticker restart not enabled' });
      return;
    }
    let restarted: string[];
    try {
      restarted = tickerRestarter();
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    res.json({ restarted });
  });

  // ---- Orchestrator (v1.4+) ------------------------------------------------

  /**
   * Symphony §13.7.2 snapshot. Returns 404 with `{ error: "orchestrator not enabled" }`
   * when the daemon was started without `--mock-tracker` / a workflow file.
   */
  app.get('/orchestrator/state', (_req: Request, res: Response) => {
    if (!orchestrator) {
      res.status(404).json({ error: 'orchestrator not enabled' });
      return;
    }
    res.json(orchestrator.snapshot());
  });

  // v1.4.11 — file a new tracker ticket. POST body: { title, description?,
  // labels?, priority? }. 404 when no tracker is wired (observation-only
  // setup); 501 when the wired tracker doesn't implement createIssue (e.g.
  // a future read-only adapter); 400 on bad input; 502 on tracker failure.
  app.post('/trackers/issues', async (req: Request, res: Response) => {
    if (!tracker) {
      res.status(404).json({ error: 'tracker not enabled' });
      return;
    }
    if (typeof tracker.createIssue !== 'function') {
      res.status(501).json({ error: 'tracker does not implement createIssue', kind: tracker.kind });
      return;
    }
    // v1.4.15 — rate limit. Evict timestamps older than the window, then
    // check + (on success) record. 429 carries `retry_after_ms` so the
    // MCP tool can surface a "wait N seconds" message instead of looping.
    if (fileTicketMaxPerHour > 0) {
      const now = fileTicketClock();
      const cutoff = now - FILE_TICKET_WINDOW_MS;
      while (fileTicketTimestamps.length > 0 && (fileTicketTimestamps[0] ?? 0) < cutoff) {
        fileTicketTimestamps.shift();
      }
      if (fileTicketTimestamps.length >= fileTicketMaxPerHour) {
        const oldest = fileTicketTimestamps[0] ?? now;
        const retryAfterMs = Math.max(0, oldest + FILE_TICKET_WINDOW_MS - now);
        res.status(429).json({
          error: `file_ticket rate limit exceeded (${fileTicketMaxPerHour}/hour)`,
          code: 'file_ticket_rate_limited',
          retry_after_ms: retryAfterMs,
          limit: fileTicketMaxPerHour,
        });
        return;
      }
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const description = typeof body.description === 'string' ? body.description : null;
    const labels = Array.isArray(body.labels)
      ? body.labels.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : undefined;
    const priority =
      typeof body.priority === 'number' && Number.isInteger(body.priority) ? body.priority : null;
    try {
      const created = await tracker.createIssue({
        title,
        description,
        ...(labels && labels.length > 0 ? { labels } : {}),
        priority,
      });
      // Record only on actual success; failed tracker writes don't count
      // against the rate limit so a misconfigured Linear key won't lock
      // the user out of retrying.
      if (fileTicketMaxPerHour > 0) fileTicketTimestamps.push(fileTicketClock());
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof TrackerError) {
        res.status(502).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // v1.4.17 — Move a tracker ticket into a named state. Body: {workstream_id,
  // state, comment?}. Looks up the linked issue id via workstream_links, calls
  // tracker.applyTransition. Optionally posts a comment first (when supplied)
  // so the agent's reasoning lands on the issue alongside the state change.
  // 404 no tracker / no link / no createIssue support; 400 missing fields;
  // 422 when the state name doesn't resolve; 502 on TrackerError.
  app.post('/trackers/transition', async (req: Request, res: Response) => {
    if (!tracker) {
      res.status(404).json({ error: 'tracker not enabled' });
      return;
    }
    if (typeof tracker.applyTransition !== 'function') {
      res.status(501).json({
        error: 'tracker does not implement applyTransition',
        kind: tracker.kind,
      });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workstreamId = typeof body.workstream_id === 'string' ? body.workstream_id : '';
    const stateName = typeof body.state === 'string' ? body.state.trim() : '';
    if (!workstreamId || !stateName) {
      res.status(400).json({ error: 'workstream_id and state are required' });
      return;
    }
    if (!workstreamLinks) {
      res.status(404).json({ error: 'links not enabled' });
      return;
    }
    const link = workstreamLinks.get(workstreamId);
    if (!link) {
      res.status(404).json({ error: `no tracker link for workstream "${workstreamId}"` });
      return;
    }
    const comment = typeof body.comment === 'string' ? body.comment : null;
    try {
      // v1.4.17 — comment first (best-effort: a failed comment shouldn't
      // block the state transition since the agent has already decided).
      if (
        comment &&
        comment.length > 0 &&
        // Use the existing addIssueComment surface — Linear has it; mock
        // doesn't bother. Cast through unknown so TS doesn't complain.
        typeof (tracker as unknown as { addIssueComment?: unknown }).addIssueComment === 'function'
      ) {
        try {
          await (
            tracker as unknown as {
              addIssueComment: (id: string, body: string) => Promise<unknown>;
            }
          ).addIssueComment(link.issue_id, comment);
        } catch {
          // best-effort
        }
      }
      const ok = await tracker.applyTransition(link.issue_id, stateName);
      if (!ok) {
        res.status(422).json({
          error: `state "${stateName}" did not resolve to a tracker stateId`,
          code: 'state_not_found',
        });
        return;
      }
      res
        .status(200)
        .json({ ok: true, workstream_id: workstreamId, issue_id: link.issue_id, state: stateName });
    } catch (err) {
      if (err instanceof TrackerError) {
        res.status(502).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
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

  /**
   * Lifecycle update: status and/or title. Body is `{status?, title?}`. Emits
   * one `workstream_updated` event per call (with `prev` and `changes` so the
   * timeline can render a single row that captures the transition).
   */
  app.patch('/workstreams/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const existing = registry.get(id);
    if (!existing) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as { status?: unknown; title?: unknown };
    const changes: { status?: WorkstreamStatus; title?: string } = {};
    const prev: { status?: WorkstreamStatus; title?: string } = {};

    if (body.status !== undefined) {
      if (
        typeof body.status !== 'string' ||
        !WORKSTREAM_STATUSES.has(body.status as WorkstreamStatus)
      ) {
        res.status(400).json({ error: 'status must be one of backlog, active, paused, retired' });
        return;
      }
      const nextStatus = body.status as WorkstreamStatus;
      if (nextStatus !== existing.status) {
        changes.status = nextStatus;
        prev.status = existing.status;
      }
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.length === 0) {
        res.status(400).json({ error: 'title must be a non-empty string' });
        return;
      }
      if (body.title !== existing.title) {
        changes.title = body.title;
        prev.title = existing.title;
      }
    }

    if (Object.keys(changes).length === 0) {
      // Nothing to do — return current wire object, no event.
      const detail = registry.detail(id);
      res.json(await serializeWorkstream(detail ?? existing));
      return;
    }

    if (changes.status !== undefined) registry.setStatus(id, changes.status);
    if (changes.title !== undefined) registry.setTitle(id, changes.title);

    const event: ManagerEvent = {
      ts: new Date().toISOString(),
      workstream_id: id,
      type: 'workstream_updated',
      id: `wsu_${randomUUID().slice(0, 8)}`,
      payload: { changes, prev },
    };
    await eventStore.appendEvent(id, event);

    const detail = registry.detail(id);
    res.json(await serializeWorkstream(detail ?? existing));
  });

  /**
   * Soft-delete: sets status to retired. We return the updated wire object
   * (200) for symmetry with PATCH, not 204, so clients don't need a separate
   * GET to refresh local state.
   */
  app.delete('/workstreams/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const existing = registry.get(id);
    if (!existing) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (existing.status !== 'retired') {
      registry.setStatus(id, 'retired');
      const event: ManagerEvent = {
        ts: new Date().toISOString(),
        workstream_id: id,
        type: 'workstream_updated',
        id: `wsu_${randomUUID().slice(0, 8)}`,
        payload: {
          changes: { status: 'retired' },
          prev: { status: existing.status },
        },
      };
      await eventStore.appendEvent(id, event);
    }
    const detail = registry.detail(id);
    res.json(await serializeWorkstream(detail ?? existing));
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

  // ---- Tracker links (v1.2) ------------------------------------------------

  /**
   * Either returns 200 + WorkstreamLink, or — when the workstream exists but
   * has no link — 200 + null body. Distinguishes "no link yet" (a normal,
   * not-an-error state for the macOS chip) from "workstream not found"
   * (404).
   */
  app.get('/workstreams/:id/link', (req: Request, res: Response) => {
    if (!workstreamLinks) {
      res.status(404).json({ error: 'links not enabled' });
      return;
    }
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'workstream not found' });
      return;
    }
    const link = workstreamLinks.get(id);
    res.json(link);
  });

  /**
   * Body `{tracker_kind: 'linear', issue_identifier: 'ENG-123'}`. Resolves
   * via `LinearTracker.fetchIssueByIdentifier`, persists. 503 when no Linear
   * key is configured (settings file or env), 400 when Linear can't find
   * the identifier, 404 when the workstream doesn't exist.
   */
  app.put('/workstreams/:id/link', async (req: Request, res: Response) => {
    if (!workstreamLinks) {
      res.status(404).json({ error: 'links not enabled' });
      return;
    }
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'workstream not found' });
      return;
    }
    const body = (req.body ?? {}) as {
      tracker_kind?: unknown;
      issue_identifier?: unknown;
    };
    if (body.tracker_kind !== 'linear') {
      res.status(400).json({ error: "tracker_kind must be 'linear'" });
      return;
    }
    if (typeof body.issue_identifier !== 'string' || body.issue_identifier.length === 0) {
      res.status(400).json({ error: 'issue_identifier required' });
      return;
    }
    const apiKey = settings?.getResolvedLinearApiKey();
    if (!apiKey) {
      res
        .status(503)
        .json({ error: 'Linear API key not configured', code: 'linear_api_key_missing' });
      return;
    }
    let tracker: ReturnType<typeof linearTrackerFactory>;
    try {
      tracker = linearTrackerFactory(apiKey);
    } catch (err) {
      const code = err instanceof TrackerError ? err.code : 'tracker_init_failed';
      res.status(500).json({ error: (err as Error).message, code });
      return;
    }
    let issue: { id: string; identifier: string; url: string | null; state: string } | null;
    try {
      issue = await tracker.fetchIssueByIdentifier(body.issue_identifier);
    } catch (err) {
      const code = err instanceof TrackerError ? err.code : 'linear_api_request';
      res.status(502).json({ error: (err as Error).message, code });
      return;
    }
    if (!issue) {
      res.status(400).json({
        error: `Linear issue ${body.issue_identifier} not found`,
        code: 'linear_unknown_identifier',
      });
      return;
    }
    const persisted = workstreamLinks.link({
      workstreamId: id,
      trackerKind: 'linear',
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueUrl: issue.url,
      lastSeenState: issue.state,
    });
    res.json(persisted);
  });

  /** Idempotent — deleting a non-existent link is still a 200. */
  app.delete('/workstreams/:id/link', (req: Request, res: Response) => {
    if (!workstreamLinks) {
      res.status(404).json({ error: 'links not enabled' });
      return;
    }
    const id = String(req.params['id']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'workstream not found' });
      return;
    }
    workstreamLinks.unlink(id);
    res.json({ ok: true });
  });

  app.get('/links', (_req: Request, res: Response) => {
    if (!workstreamLinks) {
      res.status(404).json({ error: 'links not enabled' });
      return;
    }
    res.json(workstreamLinks.list());
  });

  // ---- Hooks ---------------------------------------------------------------

  for (const [hook, type] of Object.entries(HOOK_TYPE_MAP)) {
    app.post(`/hooks/${hook}`, async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as HookBody;
      const workstreamId = String(
        body.workstream ?? process.env['DISPATCH_WORKSTREAM'] ?? 'default',
      );
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

  app.post('/interventions', async (req: Request, res: Response) => {
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
      res.status(400).json({
        error:
          'kind must be one of nudge, redirect, rollback, approval_required, question_required',
      });
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
    // Mirror the enqueue into the event store so per-workstream WS streams
    // broadcast it. The Radar's digest counter and the AgentDetailView's
    // ApprovalStrip both refresh off these events instead of polling.
    const enqueuedEvent: ManagerEvent = {
      ts: intervention.created_at,
      workstream_id: workstreamId,
      type: 'intervention_enqueued',
      id: `intq_${randomUUID().slice(0, 8)}`,
      payload: {
        intervention_id: intervention.id,
        kind: intervention.kind,
      },
    };
    await eventStore.appendEvent(workstreamId, enqueuedEvent);
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

  /**
   * v1.4.4 — record manager's Approve/Deny decision on an `approval_required`
   * intervention. Body: `{ approved: bool }`. Returns the updated wire row.
   * Marks delivered in the same transaction (no separate ack needed).
   */
  app.post('/workstreams/:id/interventions/:intId/decide', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const intId = String(req.params['intId']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'workstream not found' });
      return;
    }
    const body = (req.body ?? {}) as { approved?: unknown };
    if (typeof body.approved !== 'boolean') {
      res.status(400).json({ error: 'approved must be a boolean' });
      return;
    }
    const updated = interventionQueue.decideApproval(intId, body.approved);
    if (!updated) {
      res.status(404).json({
        error: 'intervention not found, already delivered, or not approval_required',
      });
      return;
    }
    const event: ManagerEvent = {
      ts: updated.delivered_at ?? new Date().toISOString(),
      workstream_id: updated.workstream_id,
      type: 'intervention_delivered',
      id: `intd_${randomUUID().slice(0, 8)}`,
      payload: {
        intervention_id: updated.id,
        kind: updated.kind,
        approved: body.approved,
      },
    };
    await eventStore.appendEvent(updated.workstream_id, event);
    res.json(updated);
  });

  /**
   * v1.4.7 — record manager's answer to a `question_required` intervention.
   * Body: `{ choice?: string, freetext?: string }`. At least one must be a
   * non-empty string. When the original `question_request.options` is set,
   * `choice` (if supplied) must match one of those options exactly. When
   * `allow_freetext` was not set, `freetext` is rejected. Returns the
   * updated wire row; marks delivered atomically and emits an
   * `intervention_delivered` event with the answer attached so WS streams
   * notify the macOS UI.
   */
  app.post('/workstreams/:id/interventions/:intId/answer', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const intId = String(req.params['intId']);
    if (!registry.get(id)) {
      res.status(404).json({ error: 'workstream not found' });
      return;
    }
    const body = (req.body ?? {}) as { choice?: unknown; freetext?: unknown };
    const choice =
      typeof body.choice === 'string' && body.choice.length > 0 ? body.choice : undefined;
    const freetext =
      typeof body.freetext === 'string' && body.freetext.length > 0 ? body.freetext : undefined;
    if (!choice && !freetext) {
      res.status(400).json({ error: 'choice or freetext required' });
      return;
    }
    const existing = interventionQueue.get(intId);
    if (!existing || existing.workstream_id !== id) {
      res.status(404).json({ error: 'intervention not found' });
      return;
    }
    if (existing.kind !== 'question_required') {
      res.status(400).json({ error: 'intervention is not a question_required' });
      return;
    }
    if (existing.delivered_at !== null) {
      res.status(409).json({ error: 'intervention already answered' });
      return;
    }
    const request = existing.payload.question_request;
    if (choice && Array.isArray(request?.options) && request.options.length > 0) {
      if (!request.options.includes(choice)) {
        res.status(400).json({ error: 'choice does not match a known option' });
        return;
      }
    }
    if (freetext && request?.allow_freetext !== true) {
      res.status(400).json({ error: 'freetext not allowed for this question' });
      return;
    }
    const updated = interventionQueue.answerQuestion(intId, {
      ...(choice ? { choice } : {}),
      ...(freetext ? { freetext } : {}),
    });
    if (!updated) {
      res.status(404).json({ error: 'intervention not found or already answered' });
      return;
    }
    const event: ManagerEvent = {
      ts: updated.delivered_at ?? new Date().toISOString(),
      workstream_id: updated.workstream_id,
      type: 'intervention_delivered',
      id: `intd_${randomUUID().slice(0, 8)}`,
      payload: {
        intervention_id: updated.id,
        kind: updated.kind,
        ...(choice ? { choice } : {}),
        ...(freetext ? { freetext } : {}),
      },
    };
    await eventStore.appendEvent(updated.workstream_id, event);
    res.json(updated);
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

  // ---- Digest --------------------------------------------------------------

  app.get('/digest', async (req: Request, res: Response) => {
    const sinceRaw = req.query['since'];
    let since: Date;
    if (typeof sinceRaw === 'string' && sinceRaw.length > 0) {
      const parsed = new Date(sinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: 'since must be an ISO-8601 timestamp' });
        return;
      }
      since = parsed;
    } else {
      since = new Date(Date.now() - DIGEST_DEFAULT_WINDOW_MS);
    }
    const digest = await buildDigest({ registry, eventStore, interventionQueue }, since);
    res.json(digest);
  });

  // ---- Team handbook + skill broadcast ------------------------------------

  app.get('/handbook', async (_req: Request, res: Response) => {
    const md = await handbookStore.read();
    res.type('text/markdown').send(md);
  });

  app.post('/handbook/skills', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      title?: unknown;
      body?: unknown;
      source?: unknown;
    };
    if (typeof body.title !== 'string' || body.title.length === 0) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    if (typeof body.body !== 'string' || body.body.length === 0) {
      res.status(400).json({ error: 'body required' });
      return;
    }
    const source = parseSkillSource(body.source);
    await handbookStore.appendSkill(body.title, body.body, source);
    res.status(201).json({ title: body.title });
  });

  app.get('/skills/proposed', (_req: Request, res: Response) => {
    res.json(skillProposalsStore.listProposed());
  });

  app.post('/skills/proposed/:id/promote', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const proposal = skillProposalsStore.get(id);
    if (!proposal) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (proposal.status !== 'proposed') {
      res.status(409).json({ error: `already ${proposal.status}` });
      return;
    }
    const source: SkillSource = { workstream_id: proposal.workstream_id };
    if (proposal.source_decision_id) source.decision_id = proposal.source_decision_id;
    await handbookStore.appendSkill(proposal.title, proposal.body, source);
    const updated = skillProposalsStore.markPromoted(id);
    if (registry.get(proposal.workstream_id)) {
      const event: ManagerEvent = {
        ts: new Date().toISOString(),
        workstream_id: proposal.workstream_id,
        type: 'skill_promoted',
        id: `skp_${randomUUID().slice(0, 8)}`,
        payload: {
          proposal_id: proposal.id,
          title: proposal.title,
        },
      };
      await eventStore.appendEvent(proposal.workstream_id, event);
    }
    res.json(updated);
  });

  app.post('/skills/proposed/:id/dismiss', (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const proposal = skillProposalsStore.get(id);
    if (!proposal) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (proposal.status !== 'proposed') {
      res.status(409).json({ error: `already ${proposal.status}` });
      return;
    }
    const updated = skillProposalsStore.markDismissed(id);
    res.json(updated);
  });

  // ---- Reports + presets + scheduler --------------------------------------

  app.get('/report-presets', (_req: Request, res: Response) => {
    res.json(PRESETS);
  });

  /**
   * Generate a new report. Validates inputs, builds the deterministic context
   * via `assembleReport`, picks the system prompt (preset or freetext
   * override), calls the chosen LLM provider, and persists the result. The
   * persisted row is returned regardless of whether `save: true` (status =
   * 'saved') or `save: false` (status = 'draft') so the client always has an
   * id to reference.
   */
  app.post('/reports/generate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      workstream_ids?: unknown;
      since?: unknown;
      until?: unknown;
      audience_preset?: unknown;
      audience_freetext?: unknown;
      provider?: unknown;
      model?: unknown;
      save?: unknown;
      title?: unknown;
    };

    const provider =
      typeof body.provider === 'string' ? (body.provider as LLMProviderName) : undefined;
    if (!provider || !VALID_PROVIDERS.has(provider)) {
      res.status(400).json({ error: "provider must be 'claude' or 'ollama'" });
      return;
    }

    const audiencePreset =
      typeof body.audience_preset === 'string' && body.audience_preset.length > 0
        ? body.audience_preset
        : null;
    if (audiencePreset !== null && !getPreset(audiencePreset)) {
      res.status(400).json({ error: `unknown audience_preset: ${audiencePreset}` });
      return;
    }
    const audienceFreetext =
      typeof body.audience_freetext === 'string' && body.audience_freetext.trim().length > 0
        ? body.audience_freetext.trim()
        : null;
    const systemPrompt = resolveSystemPrompt({
      preset_id: audiencePreset,
      freetext: audienceFreetext,
    });
    if (!systemPrompt) {
      res.status(400).json({ error: 'audience_preset or audience_freetext required' });
      return;
    }

    // Resolve workstream_ids: caller-supplied (validated) or all active.
    let workstreamIds: string[];
    if (Array.isArray(body.workstream_ids)) {
      workstreamIds = body.workstream_ids.filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      );
      if (workstreamIds.length === 0) {
        res.status(400).json({ error: 'workstream_ids must be a non-empty array of strings' });
        return;
      }
    } else {
      workstreamIds = registry
        .list()
        .filter((w) => w.status === 'active')
        .map((w) => w.id);
    }

    // Resolve window.
    const now = new Date();
    let since: Date;
    let until: Date;
    if (typeof body.since === 'string' && body.since.length > 0) {
      const parsed = new Date(body.since);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: 'since must be ISO-8601' });
        return;
      }
      since = parsed;
    } else {
      since = new Date(now.getTime() - REPORT_DEFAULT_WINDOW_MS);
    }
    if (typeof body.until === 'string' && body.until.length > 0) {
      const parsed = new Date(body.until);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: 'until must be ISO-8601' });
        return;
      }
      until = parsed;
    } else {
      until = now;
    }

    const ctx = await assembleReport(
      { registry, eventStore, memoryStore },
      { workstream_ids: workstreamIds, since, until },
    );

    const audienceLabel = audienceFreetext ?? getPreset(audiencePreset ?? '')?.name ?? 'team';
    const periodLabel = derivePeriodLabel(since, until);
    const userPrompt = renderUserPrompt({
      ctx,
      audience_label: audienceLabel,
      period_label: periodLabel,
    });

    const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
    // Pass settings-derived overrides so a key/URL the user typed into
    // Settings → Providers reaches the provider without needing to be in the
    // daemon's process env.
    const overrides: ProviderOverrides | undefined = settings
      ? {
          ...(settings.getResolvedAnthropicApiKey() !== undefined
            ? { anthropicApiKey: settings.getResolvedAnthropicApiKey() as string }
            : {}),
          ollamaUrl: settings.getResolvedOllamaUrl(),
        }
      : undefined;
    let bodyMd: string;
    try {
      const llm = getProvider(provider, overrides);
      bodyMd = await llm.generate({
        system: systemPrompt,
        user: userPrompt,
        ...(model ? { model } : {}),
      });
    } catch (err) {
      if (err instanceof LLMUnreachableError) {
        res.status(503).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof LLMConfigError) {
        res.status(500).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof LLMRequestError) {
        // Upstream 4xx is user-actionable (e.g. Ollama "model not found" when
        // the requested model isn't pulled). Surface as 422 with the upstream
        // detail so the client can render a helpful message instead of an
        // opaque 500. Upstream 5xx / parse failures are bad-gateway-ish.
        const upstreamIs4xx = err.status !== null && err.status >= 400 && err.status < 500;
        res
          .status(upstreamIs4xx ? 422 : 502)
          .json({ error: err.message, code: err.code, upstream_status: err.status });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `LLM generation failed: ${message}` });
      return;
    }

    const save = body.save === true;
    const title =
      typeof body.title === 'string' && body.title.length > 0
        ? body.title
        : `${periodLabel} — ${until.toISOString().slice(0, 10)}`;
    const stored = reportStore.create({
      title,
      audience_preset: audiencePreset,
      audience_freetext: audienceFreetext,
      period_since: since.toISOString(),
      period_until: until.toISOString(),
      workstream_ids: workstreamIds,
      provider,
      model,
      body_md: bodyMd,
      status: save ? 'saved' : 'draft',
    });
    res.status(201).json(stored);
  });

  app.get('/reports', (req: Request, res: Response) => {
    const status =
      typeof req.query['status'] === 'string' ? (req.query['status'] as ReportStatus) : undefined;
    if (status !== undefined && !VALID_REPORT_STATUSES.has(status)) {
      res.status(400).json({ error: 'status must be one of draft, saved, archived' });
      return;
    }
    const reports = status ? reportStore.list({ status }) : reportStore.list();
    res.json(reports);
  });

  app.get('/reports/:id', (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const r = reportStore.get(id);
    if (!r) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(r);
  });

  app.patch('/reports/:id', (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const body = (req.body ?? {}) as { title?: unknown; body_md?: unknown; status?: unknown };
    const fields: { title?: string; body_md?: string; status?: ReportStatus } = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.length === 0) {
        res.status(400).json({ error: 'title must be a non-empty string' });
        return;
      }
      fields.title = body.title;
    }
    if (body.body_md !== undefined) {
      if (typeof body.body_md !== 'string') {
        res.status(400).json({ error: 'body_md must be a string' });
        return;
      }
      fields.body_md = body.body_md;
    }
    if (body.status !== undefined) {
      if (
        typeof body.status !== 'string' ||
        !VALID_REPORT_STATUSES.has(body.status as ReportStatus)
      ) {
        res.status(400).json({ error: 'status must be one of draft, saved, archived' });
        return;
      }
      fields.status = body.status as ReportStatus;
    }
    const updated = reportStore.update(id, fields);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(updated);
  });

  /** Soft-delete via status=archived; returns the updated row, not 204. */
  app.delete('/reports/:id', (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const updated = reportStore.update(id, { status: 'archived' });
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(updated);
  });

  app.get('/scheduler/jobs', (_req: Request, res: Response) => {
    res.json(scheduler.listJobs());
  });

  app.patch('/scheduler/jobs/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const body = (req.body ?? {}) as {
      enabled?: unknown;
      cron?: unknown;
      audience_preset?: unknown;
      provider?: unknown;
      model?: unknown;
    };
    const fields: SchedulerJobUpdate = {};
    if (body.enabled !== undefined) fields.enabled = !!body.enabled;
    if (body.cron !== undefined) {
      if (typeof body.cron !== 'string' || body.cron.length === 0) {
        res.status(400).json({ error: 'cron must be a non-empty string' });
        return;
      }
      fields.cron = body.cron;
    }
    if (body.audience_preset !== undefined) {
      if (typeof body.audience_preset !== 'string' || !getPreset(body.audience_preset)) {
        res.status(400).json({ error: 'audience_preset must be a known preset id' });
        return;
      }
      fields.audience_preset = body.audience_preset;
    }
    if (body.provider !== undefined) {
      if (
        typeof body.provider !== 'string' ||
        !VALID_PROVIDERS.has(body.provider as LLMProviderName)
      ) {
        res.status(400).json({ error: "provider must be 'claude' or 'ollama'" });
        return;
      }
      fields.provider = body.provider as LLMProviderName;
    }
    if (body.model !== undefined) {
      if (body.model !== null && typeof body.model !== 'string') {
        res.status(400).json({ error: 'model must be a string or null' });
        return;
      }
      fields.model = body.model as string | null;
    }
    try {
      const updated = await scheduler.updateJob(id, fields);
      res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('unknown scheduler job')) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
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

/**
 * Heuristic period label used when the caller doesn't supply a title. Picks
 * "Weekly", "Monthly", or "Custom" based on the window size.
 */
function derivePeriodLabel(since: Date, until: Date): string {
  const ms = until.getTime() - since.getTime();
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 6.5 && days <= 8.5) return 'Weekly update';
  if (days >= 27 && days <= 32) return 'Monthly update';
  return 'Update';
}

function parseSkillSource(raw: unknown): SkillSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { workstream_id?: unknown; decision_id?: unknown };
  const out: SkillSource = {};
  if (typeof r.workstream_id === 'string' && r.workstream_id.length > 0) {
    out.workstream_id = r.workstream_id;
  }
  if (typeof r.decision_id === 'string' && r.decision_id.length > 0) {
    out.decision_id = r.decision_id;
  }
  return Object.keys(out).length === 0 ? undefined : out;
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
