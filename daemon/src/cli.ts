import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { getConfig } from './config.js';
import { EventStore } from './event-store.js';
import { HandbookStore } from './handbook-store.js';
import { HeadlineStore } from './headline-store.js';
import { Headliner } from './headliner.js';
import { LinearCommentSyncer } from './linear-comment-syncer.js';
import { SubgoalSynthesizer } from './subgoal-synthesizer.js';
import { buildHttpServer } from './http-server.js';
import {
  Orchestrator,
  type ClaimHook,
  type ClaimOutcome,
  type DispatchOutcome,
  type ReleaseHook,
} from './orchestrator.js';
import { MockTracker } from './trackers/mock.js';
import { LinearTracker } from './trackers/linear.js';
import { type AssigneeFilter, type Tracker, TrackerError } from './trackers/index.js';
import { loadWorkflow, watchWorkflow, WorkflowError } from './workflow-loader.js';
import { WorkspaceManager } from './workspaces.js';
import { AgentRunner } from './agent-runner.js';
import { InterventionQueue } from './intervention-queue.js';
import { buildMcpServer, startMcpStdio } from './mcp-server.js';
import { MemoryStore } from './memory-store.js';
import { ReportStore } from './report-store.js';
import { Scheduler } from './scheduler.js';
import { SettingsStore } from './settings-store.js';
import { SkillProposalsStore } from './skill-proposals.js';
import { WorkstreamLinksStore } from './workstream-links-store.js';
import { WorkstreamRegistry } from './workstream.js';
import { randomUUID } from 'node:crypto';

/**
 * Whether to launch an MCP stdio server in `dispatch start`.
 * Off by default so a daemon launched as a long-running background process
 * doesn't try to read from a non-existent stdin (which would EOF immediately).
 *
 * Note: in v0.5.2 the production wiring is `dispatch mcp` (stdio-only, no HTTP),
 * which Claude Code launches per session. The `--mcp-stdio` flag on `start`
 * is kept for backward compat / testing only — it binds BOTH HTTP and MCP, so
 * if a long-running daemon is already up they will fight for the port.
 */
const MCP_STDIO_FLAG = '--mcp-stdio';

export function buildCli(): Command {
  const program = new Command();
  program
    .name('dispatch')
    .description('Dispatch daemon — local brain for supervising AI agents.')
    .version('0.0.1');

  program
    .command('start')
    .description('Boot HTTP/WS API. Optionally also bind an MCP server to stdio.')
    .option(
      MCP_STDIO_FLAG,
      'Bind the MCP server to stdio (testing only — production uses `dispatch mcp`).',
    )
    .option(
      '--mock-tracker <path>',
      'v1.4.0 dev: enable orchestrator with a MockTracker reading <path>. Useful with --dry-run.',
    )
    .option(
      '--workflow <path>',
      'v1.4.3: load WORKFLOW.md from <path> and enable the orchestrator + agent runner.',
    )
    .option('--dry-run', 'v1.4.x: orchestrator logs "would dispatch" instead of spawning an agent.')
    .action(
      async (opts: {
        mcpStdio?: boolean;
        mockTracker?: string;
        workflow?: string;
        dryRun?: boolean;
      }) => {
        await runStart({
          mcpStdio: !!opts.mcpStdio,
          mockTracker: opts.mockTracker,
          workflow: opts.workflow,
          dryRun: !!opts.dryRun,
        });
      },
    );

  program
    .command('mcp')
    .description('Run MCP stdio server only (no HTTP). What Claude Code launches per session.')
    .action(async () => {
      await runMcp();
    });

  program
    .command('register <id> <title>')
    .description('Create a workstream.')
    .action((id: string, title: string) => {
      const cfg = getConfig();
      const registry = new WorkstreamRegistry(cfg.dbPath);
      try {
        const existing = registry.get(id);
        if (existing) {
          process.stdout.write(`workstream "${id}" already exists\n`);
          return;
        }
        const ws = registry.create(id, title);
        process.stdout.write(
          `registered ${ws.id} — ${ws.title} (status=${ws.status}, created_at=${ws.createdAt})\n`,
        );
      } finally {
        registry.close();
      }
    });

  program
    .command('list')
    .description('List workstreams.')
    .action(() => {
      const cfg = getConfig();
      const registry = new WorkstreamRegistry(cfg.dbPath);
      try {
        const all = registry.list();
        if (all.length === 0) {
          process.stdout.write('(no workstreams)\n');
          return;
        }
        const idW = Math.max(2, ...all.map((w) => w.id.length));
        const titleW = Math.max(5, ...all.map((w) => w.title.length));
        const statusW = Math.max(6, ...all.map((w) => w.status.length));
        const header = `${pad('ID', idW)}  ${pad('TITLE', titleW)}  ${pad('STATUS', statusW)}  CREATED`;
        process.stdout.write(`${header}\n`);
        process.stdout.write(`${'-'.repeat(header.length)}\n`);
        for (const w of all) {
          process.stdout.write(
            `${pad(w.id, idW)}  ${pad(w.title, titleW)}  ${pad(w.status, statusW)}  ${w.createdAt}\n`,
          );
        }
      } finally {
        registry.close();
      }
    });

  program
    .command('attach <workstream-id>')
    .description('Print env vars and instructions for hooking a Claude Code session.')
    .action((workstreamId: string) => {
      const cfg = getConfig();
      const sessionId = `sess-${Date.now().toString(36)}`;
      const repo = resolveRepoRoot();
      process.stdout.write(
        [
          '# Add these to your shell before launching Claude Code:',
          `export DISPATCH_WORKSTREAM=${shellQuote(workstreamId)}`,
          `export DISPATCH_SESSION_ID=${shellQuote(sessionId)}`,
          `export DISPATCH_PORT=${cfg.httpPort}`,
          '',
          '# Install the lifecycle hooks (one-time, user-scoped):',
          '#   bash hooks/install.sh',
          '',
          "# Wire Claude Code's MCP to dispatch (one-time, user-scoped):",
          `#   claude mcp add dispatch --scope user -- node "${repo}/daemon/dist/index.js" mcp`,
        ].join('\n'),
      );
      process.stdout.write('\n');
    });

  return program;
}

/**
 * Resolve the absolute path to the repo root from this module's URL. Walks up
 * from `daemon/dist/cli.js` (production) or `daemon/src/cli.ts` (dev via tsx).
 * Falls back to process.cwd() if URL resolution fails.
 */
function resolveRepoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // here is .../daemon/dist (built) or .../daemon/src (dev). Repo root is
    // two levels up in either case.
    return resolve(here, '..', '..');
  } catch {
    return process.cwd();
  }
}

async function runStart(opts: {
  mcpStdio: boolean;
  mockTracker?: string;
  workflow?: string;
  dryRun?: boolean;
}): Promise<void> {
  const cfg = getConfig();
  await Promise.all([
    mkdir(cfg.eventsDir, { recursive: true }),
    mkdir(cfg.memoryDir, { recursive: true }),
    mkdir(cfg.queuesDir, { recursive: true }),
  ]);
  const registry = new WorkstreamRegistry(cfg.dbPath);
  const eventStore = new EventStore(cfg.eventsDir);
  const memoryStore = new MemoryStore(cfg.memoryDir);
  const interventionQueue = new InterventionQueue(cfg.dbPath);
  const handbookStore = new HandbookStore();
  const skillProposalsStore = new SkillProposalsStore(cfg.dbPath);
  const reportStore = new ReportStore(cfg.dbPath);
  const scheduler = new Scheduler({ registry, eventStore, memoryStore, reportStore });
  const headlineStore = new HeadlineStore();
  const settings = new SettingsStore(cfg.settingsPath);
  let headliner = new Headliner({ registry, eventStore, store: headlineStore, settings });
  const workstreamLinks = new WorkstreamLinksStore(cfg.dbPath);

  // v1.4.6 — TickerSupervisor: keeps mutable references to every running
  // ticker so the `POST /admin/restart` endpoint can cancel + re-instantiate
  // them in place (re-reading settings.json) without exiting the daemon.
  let subgoalSynth: SubgoalSynthesizer | null = null;
  let linearSyncerRef: LinearCommentSyncer | null = null;
  const restartTickers = (): string[] => {
    const restarted: string[] = [];
    if (process.env['DISPATCH_HEADLINE_ENABLED'] !== '0') {
      headliner.stop();
      headliner = new Headliner({ registry, eventStore, store: headlineStore, settings });
      headliner.start();
      restarted.push('headliner');
    }
    if (subgoalSynth) {
      subgoalSynth.stop();
      subgoalSynth = new SubgoalSynthesizer({ registry, eventStore, settings });
      subgoalSynth.start();
      restarted.push('subgoal_synth');
    }
    if (linearSyncerRef) {
      linearSyncerRef.stop();
      linearSyncerRef = new LinearCommentSyncer({
        registry,
        eventStore,
        store: workstreamLinks,
        settings,
        trackerFactory: (apiKey: string) =>
          new LinearTracker({ apiKey, projectSlug: 'unused-for-link-flow' }),
      });
      linearSyncerRef.onWorkstreamUpdated = (e) => {
        const event = {
          ts: new Date().toISOString(),
          workstream_id: e.workstreamId,
          type: 'workstream_updated' as const,
          id: `wsu_${randomUUID().slice(0, 8)}`,
          payload: {
            changes: { status: e.nextStatus },
            prev: { status: e.prevStatus },
            source: 'linear_sync',
          },
        };
        void eventStore.appendEvent(e.workstreamId, event);
      };
      linearSyncerRef.start();
      restarted.push('linear_sync');
    }
    return restarted;
  };
  // Orchestrator is built below if --mock-tracker was passed; we late-bind it
  // into the HTTP server via a closure-captured holder so the route can find it.
  const orchestratorHolder: { current: Orchestrator | null } = { current: null };
  const http = buildHttpServer({
    eventStore,
    memoryStore,
    registry,
    interventionQueue,
    handbookStore,
    skillProposalsStore,
    reportStore,
    scheduler,
    headlineStore,
    settings,
    workstreamLinks,
    tickerRestarter: restartTickers,
    get orchestrator() {
      return orchestratorHolder.current ?? undefined;
    },
  } as Parameters<typeof buildHttpServer>[0]);
  const port = await http.listen(cfg.httpPort);
  // stderr so JSON-over-stdout MCP traffic stays clean.
  process.stderr.write(`[dispatch] HTTP/WS listening on http://127.0.0.1:${port}\n`);
  process.stderr.write(`[dispatch] state at ${cfg.home}\n`);
  await scheduler.start();
  process.stderr.write('[dispatch] scheduler started\n');
  if (process.env['DISPATCH_HEADLINE_ENABLED'] !== '0') {
    headliner.start();
    process.stderr.write('[dispatch] headliner started\n');
  }
  if (process.env['DISPATCH_SUBGOAL_SYNTH_ENABLED'] !== '0') {
    subgoalSynth = new SubgoalSynthesizer({ registry, eventStore, settings });
    subgoalSynth.start();
    process.stderr.write('[dispatch] subgoal synthesizer started\n');
  }

  let linearSyncer: LinearCommentSyncer | null = null;
  if (process.env['DISPATCH_LINEAR_SYNC_ENABLED'] !== '0') {
    linearSyncer = new LinearCommentSyncer({
      registry,
      eventStore,
      store: workstreamLinks,
      settings,
      trackerFactory: (apiKey: string) =>
        new LinearTracker({ apiKey, projectSlug: 'unused-for-link-flow' }),
    });
    linearSyncerRef = linearSyncer;
    linearSyncer.onWorkstreamUpdated = (e) => {
      const event = {
        ts: new Date().toISOString(),
        workstream_id: e.workstreamId,
        type: 'workstream_updated' as const,
        id: `wsu_${randomUUID().slice(0, 8)}`,
        payload: {
          changes: { status: e.nextStatus },
          prev: { status: e.prevStatus },
          source: 'linear_sync',
        },
      };
      void eventStore.appendEvent(e.workstreamId, event);
    };
    linearSyncer.start();
    process.stderr.write('[dispatch] linear comment syncer started\n');
  }

  // v1.4.x: optional orchestrator. Built from either --workflow (full path) or
  // --mock-tracker (dev shortcut). When neither is present, observation mode
  // continues exactly as today.
  let orchestrator: Orchestrator | null = null;
  let workflowWatcher: { close: () => void } | null = null;
  if (opts.workflow || opts.mockTracker) {
    const dryRun = !!opts.dryRun;

    let tracker: Tracker;
    let workspaceMgr: WorkspaceManager;
    let agentRunner: AgentRunner;
    let activeStates = ['Todo', 'In Progress'];
    let terminalStates = ['Done', 'Closed', 'Cancelled', 'Canceled', 'Duplicate'];
    let pollIntervalMs = 5_000;
    let maxConcurrent = 5;
    // v1.4.7 — defaults match v1.4.6 (no tracker write). The workflow path
    // overwrites these from cfg.tracker.
    let claimConfig: ClaimConfig = {
      enabled: false,
      assignToSelf: false,
      claimState: null,
      claimStateId: null,
      unassignedOnly: false,
    };

    if (opts.workflow) {
      let wf;
      try {
        wf = await loadWorkflow(opts.workflow);
      } catch (err) {
        if (err instanceof WorkflowError) {
          process.stderr.write(`[dispatch] workflow load failed: ${err.code} ${err.message}\n`);
          return;
        }
        throw err;
      }
      const cfg = wf.config;
      activeStates = cfg.tracker.active_states;
      terminalStates = cfg.tracker.terminal_states;
      pollIntervalMs = cfg.polling.interval_ms;
      maxConcurrent = cfg.agent.max_concurrent_agents;
      claimConfig = {
        enabled: cfg.tracker.claim_on_dispatch,
        assignToSelf: cfg.tracker.assign_to_self,
        claimState: cfg.tracker.claim_state,
        claimStateId: null,
        unassignedOnly: cfg.tracker.unassigned_only,
      };
      workspaceMgr = new WorkspaceManager({
        ...(cfg.workspace.root ? { root: cfg.workspace.root } : {}),
        hooks: cfg.hooks,
      });
      if (cfg.tracker.kind === 'linear') {
        if (!cfg.tracker.api_key || !cfg.tracker.project_slug) {
          process.stderr.write(
            '[dispatch] linear tracker requires tracker.api_key and tracker.project_slug\n',
          );
          return;
        }
        tracker = new LinearTracker({
          apiKey: cfg.tracker.api_key,
          projectSlug: cfg.tracker.project_slug,
          ...(cfg.tracker.endpoint ? { endpoint: cfg.tracker.endpoint } : {}),
        });
      } else {
        if (!cfg.tracker.source) {
          process.stderr.write('[dispatch] mock tracker requires tracker.source\n');
          return;
        }
        tracker = new MockTracker(cfg.tracker.source);
      }
      agentRunner = new AgentRunner(workspaceMgr);
    } else {
      // --mock-tracker shortcut path.
      tracker = new MockTracker(opts.mockTracker as string);
      workspaceMgr = new WorkspaceManager();
      agentRunner = new AgentRunner(workspaceMgr);
    }

    // v1.4.10.1 — eager-resolve claim_state name → tracker-native stateId.
    // Done once at boot so the per-claim path stays one round-trip; resolution
    // failure degrades gracefully (assignee still flips, state stays put).
    if (claimConfig.enabled && claimConfig.claimState) {
      claimConfig.claimStateId = await resolveClaimStateId(tracker, claimConfig.claimState);
      if (!claimConfig.claimStateId) {
        process.stderr.write(
          `[dispatch] claim_state="${claimConfig.claimState}" did not resolve to a tracker stateId — claims will flip assignee only\n`,
        );
      }
    }
    // v1.4.10 — claim/release hooks built from workflow config. Without
    // claim_on_dispatch the hooks are null and behavior is identical to
    // v1.4.9.
    const claimHook = buildClaimHook(tracker, claimConfig);
    const releaseHook = buildReleaseHook(tracker, claimConfig);

    orchestrator = new Orchestrator({
      tracker,
      activeStates,
      terminalStates,
      pollIntervalMs,
      maxConcurrentAgents: maxConcurrent,
      assigneeFilter: assigneeFilterFor(claimConfig),
      ...(claimHook ? { claimHook } : {}),
      ...(releaseHook ? { releaseHook } : {}),
      dispatchOne: async (issue, attempt) => {
        if (dryRun) {
          process.stderr.write(
            `[dispatch] orchestrator would dispatch ${issue.identifier} — ${issue.title}\n`,
          );
          return { ok: true } as DispatchOutcome;
        }
        try {
          const ws = await workspaceMgr.prepare(issue.identifier);
          const result = await agentRunner.runTurn({
            workspacePath: ws.path,
            issue,
            attempt,
            prompt: renderPrompt(issue, attempt),
            workstreamId: ws.workspace_key.toLowerCase(),
            log: (m, c) =>
              process.stderr.write(`[dispatch] ${m}${c ? ' ' + JSON.stringify(c) : ''}\n`),
          });
          return result.ok
            ? ({ ok: true } as DispatchOutcome)
            : ({ ok: false, error: result.error ?? 'turn_failed' } as DispatchOutcome);
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } as DispatchOutcome;
        }
      },
      log: (msg, ctx) =>
        process.stderr.write(`[dispatch] ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}\n`),
    });
    await orchestrator.start();
    orchestratorHolder.current = orchestrator;
    process.stderr.write(
      `[dispatch] orchestrator started (workflow=${opts.workflow ?? 'mock'}, dry-run=${dryRun})\n`,
    );

    if (opts.workflow) {
      workflowWatcher = watchWorkflow(opts.workflow, (next) => {
        if (next instanceof WorkflowError) {
          process.stderr.write(`[dispatch] workflow reload failed: ${next.code} ${next.message}\n`);
          return;
        }
        const cfg = next.config;
        // v1.4.7 — claim hooks themselves are not hot-swappable today (no
        // applyConfig path for them), but the assigneeFilter is — so a
        // workflow edit that flips unassigned_only takes effect immediately.
        // Toggling claim_on_dispatch live requires daemon restart for now.
        orchestrator?.applyConfig({
          activeStates: cfg.tracker.active_states,
          terminalStates: cfg.tracker.terminal_states,
          pollIntervalMs: cfg.polling.interval_ms,
          maxConcurrentAgents: cfg.agent.max_concurrent_agents,
          assigneeFilter: assigneeFilterFor({ unassignedOnly: cfg.tracker.unassigned_only }),
        });
        workspaceMgr.applyConfig({
          ...(cfg.workspace.root ? { root: cfg.workspace.root } : {}),
          hooks: cfg.hooks,
        });
        process.stderr.write('[dispatch] workflow reloaded\n');
      });
    }
  }

  let mcpRunning = false;
  if (opts.mcpStdio) {
    const mcp = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
    });
    await startMcpStdio(mcp);
    mcpRunning = true;
    process.stderr.write('[dispatch] MCP server bound to stdio\n');
  }

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[dispatch] shutting down\n');
    try {
      workflowWatcher?.close();
      orchestrator?.stop();
      // Read through the supervisor refs so we stop the latest restart
      // generation, not whatever was constructed at boot.
      linearSyncerRef?.stop();
      subgoalSynth?.stop();
      headliner.stop();
      scheduler.stop();
      await http.close();
      registry.close();
      interventionQueue.close();
      skillProposalsStore.close();
      reportStore.close();
      workstreamLinks.close();
    } catch (e) {
      process.stderr.write(`[dispatch] shutdown error: ${(e as Error).message}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // If MCP isn't bound, keep alive via SIGINT/SIGTERM only. If MCP is bound,
  // the stdio transport keeps the loop alive on its own.
  if (!mcpRunning) {
    // Express/HTTP server keeps the loop alive; nothing more to do.
  }
}

/**
 * MCP-only mode: stdio MCP server, NO HTTP. Reads/writes the same on-disk
 * state as the long-running `dispatch start` daemon (SQLite WAL + JSONL append
 * make this concurrent-safe). Logs only to stderr — stdout is reserved for
 * MCP JSON-RPC traffic.
 */
async function runMcp(): Promise<void> {
  const cfg = getConfig();
  await Promise.all([
    mkdir(cfg.eventsDir, { recursive: true }),
    mkdir(cfg.memoryDir, { recursive: true }),
    mkdir(cfg.queuesDir, { recursive: true }),
  ]);
  const registry = new WorkstreamRegistry(cfg.dbPath);
  const eventStore = new EventStore(cfg.eventsDir);
  const memoryStore = new MemoryStore(cfg.memoryDir);
  const interventionQueue = new InterventionQueue(cfg.dbPath);
  const skillProposalsStore = new SkillProposalsStore(cfg.dbPath);
  const mcp = buildMcpServer({
    eventStore,
    memoryStore,
    registry,
    skillProposalsStore,
    interventionQueue,
  });
  await startMcpStdio(mcp);
  process.stderr.write(`[dispatch] MCP stdio bound; state at ${cfg.home}\n`);

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[dispatch] shutting down MCP\n');
    try {
      registry.close();
      interventionQueue.close();
      skillProposalsStore.close();
    } catch (e) {
      process.stderr.write(`[dispatch] shutdown error: ${(e as Error).message}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // The stdio transport keeps the loop alive on its own.
}

/**
 * v1.4.3 minimal prompt renderer. Symphony §5.4 specifies strict-template
 * Liquid-compatible semantics; we ship a focused subset until v1.4.4 promotes
 * to the real engine: `{{ issue.<field> }}` interpolation +
 * `{% if attempt %}…{% endif %}` continuation block. No filters yet, no
 * arbitrary expressions.
 */
function renderPrompt(
  issue: {
    identifier: string;
    title: string;
    description: string | null;
    state: string;
    url: string | null;
    labels: string[];
  },
  attempt: number | null,
): string {
  const head = [
    `You are working on issue ${issue.identifier}: ${issue.title}.`,
    `State: ${issue.state}`,
    issue.url ? `URL: ${issue.url}` : '',
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : '',
    issue.description ? `\nDescription:\n${issue.description}` : '',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
  const continuation =
    attempt && attempt > 0
      ? `\n\nThis is continuation attempt #${attempt}. Resume from current workspace state. Don't re-do work that already landed.`
      : '';
  return `${head}${continuation}\n`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * v1.4.7 — internal claim/release config carried from workflow into the
 * orchestrator hooks. Mirrors `WorkflowConfig.tracker.claim_*` but flat.
 */
interface ClaimConfig {
  enabled: boolean;
  assignToSelf: boolean;
  /** Tracker-native state name from `WORKFLOW.md`. Null = leave state alone. */
  claimState: string | null;
  /**
   * v1.4.10.1 — Eagerly-resolved tracker-native state id. Populated at boot
   * via `resolveStateIdByName(claimState)`. Null when resolution failed or
   * the tracker doesn't support resolution; in that case the claim hook
   * flips assignee only.
   */
  claimStateId: string | null;
  unassignedOnly: boolean;
}

/**
 * v1.4.7 — Build the orchestrator's pre-dispatch claim hook from workflow
 * config. Returns null when claim is off or the tracker doesn't implement
 * `claimIssue` (in which case the orchestrator runs the v1.4.6 path).
 *
 * Tracker collisions surface as `linear_assignee_taken` and become
 * `{ ok: false, collided: true }`. Anything else becomes
 * `{ ok: false, collided: false, error }` so the orchestrator can pick
 * skip-this-tick vs skip-this-issue.
 */
function buildClaimHook(tracker: Tracker, cfg: ClaimConfig): ClaimHook | null {
  if (!cfg.enabled) return null;
  if (typeof tracker.claimIssue !== 'function') return null;
  return async (issue): Promise<ClaimOutcome> => {
    try {
      // assigneeId: undefined = let tracker pick self (Linear's default in
      // claimIssue); explicit null when assign_to_self is false would
      // *clear* the assignee — never useful for a claim, so don't pass.
      const opts: { assigneeId?: string | null; stateId?: string | null } = {};
      if (cfg.assignToSelf) {
        // Leave undefined so LinearTracker.claimIssue resolves selfUserId.
      }
      // v1.4.10.1 — only pass stateId if eager resolution succeeded at boot.
      if (cfg.claimStateId) opts.stateId = cfg.claimStateId;
      await tracker.claimIssue!(issue.id, opts);
      return { ok: true };
    } catch (err) {
      if (err instanceof TrackerError && err.code === 'linear_assignee_taken') {
        return { ok: false, collided: true };
      }
      return {
        ok: false,
        collided: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * v1.4.10.1 — Resolve a state name through the tracker, swallowing errors so
 * a flaky resolver call at boot doesn't kill the whole daemon. Returns null
 * on miss, on resolver-not-implemented, or on thrown error (logged).
 */
async function resolveClaimStateId(tracker: Tracker, name: string): Promise<string | null> {
  if (typeof tracker.resolveStateIdByName !== 'function') return null;
  try {
    return await tracker.resolveStateIdByName(name);
  } catch (err) {
    process.stderr.write(
      `[dispatch] claim_state resolve failed for "${name}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

function buildReleaseHook(tracker: Tracker, cfg: ClaimConfig): ReleaseHook | null {
  if (!cfg.enabled) return null;
  if (typeof tracker.releaseIssue !== 'function') return null;
  return async (ref): Promise<void> => {
    await tracker.releaseIssue!(ref.issueId);
  };
}

/**
 * v1.4.7 — Translate cfg.unassignedOnly into the assignee filter param.
 *
 * v1.4.10.2 — Default to `'unassigned_or_self'` (not strict `'unassigned'`)
 * so a daemon that crashed mid-claim re-discovers its own zombie tickets on
 * the next boot. The strict variant on the union stays available for callers
 * that explicitly want a hard "leave already-claimed alone" semantic.
 */
export function assigneeFilterFor(cfg: { unassignedOnly: boolean }): AssigneeFilter {
  return cfg.unassignedOnly ? 'unassigned_or_self' : 'any';
}
