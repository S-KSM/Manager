import { randomUUID } from 'node:crypto';
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { EventStore, ManagerEvent, ManagerEventType } from './event-store.js';
import type { InterventionQueue } from './intervention-queue.js';
import type { MemoryStore } from './memory-store.js';
import type { SkillProposalsStore } from './skill-proposals.js';
import type { WorkstreamRegistry } from './workstream.js';

/**
 * Reads the workstream id this MCP session is bound to. v0 supports a single
 * workstream per Claude Code session via the `DISPATCH_WORKSTREAM` env var;
 * v1 will switch to multiplexed sessions.
 */
function resolveWorkstreamId(): string {
  return process.env['DISPATCH_WORKSTREAM'] ?? 'default';
}

function resolveSessionId(): string | undefined {
  return process.env['DISPATCH_SESSION_ID'];
}

interface BuildOptions {
  eventStore: EventStore;
  memoryStore: MemoryStore;
  registry: WorkstreamRegistry;
  skillProposalsStore: SkillProposalsStore;
  /**
   * v1.4.7 — required for the `ask_user` tool, which enqueues a
   * `question_required` intervention and polls the queue for the manager's
   * answer. Older callers (`runMcp` MCP-only mode) must pass this too;
   * SQLite WAL keeps it concurrent-safe across processes.
   */
  interventionQueue: InterventionQueue;
  /**
   * Test seam: lets the unit suite swap in a manual clock + a shorter poll
   * interval so `ask_user` can be exercised without real timers. Production
   * leaves these undefined (defaults: real timers, 1 s poll, 300 s timeout).
   */
  askUserPollMs?: number;
  askUserDefaultTimeoutSec?: number;
  askUserMaxTimeoutSec?: number;
  /**
   * v1.4.11 — Base URL the `file_ticket` tool POSTs to. Production resolves
   * from `DISPATCH_PORT` env var (set by the hooks installer + the `attach`
   * command). Tests pass a stub origin pointing at a vitest mock server.
   */
  daemonUrl?: string;
  /** Test seam — override fetch for `file_ticket`. */
  fetchImpl?: typeof fetch;
  /**
   * v1.4.17 — Test seam for `open_pr`'s git/gh spawns. Production wires
   * `child_process.spawn`; tests inject a stub that returns canned exit
   * codes + output without actually shelling out.
   */
  openPrSpawnImpl?: OpenPrSpawn;
}

/** v1.4.17 — Subset of child_process.spawn the open_pr helper needs. */
export type OpenPrSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * MCP tools listed in docs/ARCHITECTURE.md. Each tool maps to event-store
 * and/or memory-store calls. Stdio transport — Claude Code launches the
 * daemon binary with `start` and pipes MCP traffic over stdio.
 */
const TOOLS: Tool[] = [
  {
    name: 'emit_decision',
    description:
      'Record a structured decision point. The unit the methodology timeline is built from.',
    inputSchema: {
      type: 'object',
      required: ['considered', 'choice', 'rationale', 'confidence'],
      properties: {
        considered: {
          type: 'array',
          items: { type: 'string' },
          description: 'Options the agent considered.',
        },
        choice: { type: 'string', description: 'Option chosen.' },
        rationale: { type: 'string', description: 'Why this option.' },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0..1.',
        },
        parent_id: {
          type: 'string',
          description: 'Optional parent decision id (for branching).',
        },
      },
    },
  },
  {
    name: 'emit_subgoal',
    description: 'Push a sub-goal onto the agent goal stack.',
    inputSchema: {
      type: 'object',
      required: ['goal'],
      properties: {
        goal: { type: 'string' },
        parent_id: { type: 'string' },
      },
    },
  },
  {
    name: 'emit_confidence',
    description: 'Spot-update confidence outside a decision.',
    inputSchema: {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'number', minimum: 0, maximum: 1 },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'flag_blocked',
    description: "Escalate — sets the 'needs you' flag in the UI.",
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'update_memory',
    description: 'Write into the workstream memory MD. Replaces or appends a `## section` block.',
    inputSchema: {
      type: 'object',
      required: ['section', 'content'],
      properties: {
        section: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  {
    name: 'read_memory',
    description: 'Read the workstream memory MD. If `section` is given, returns just that section.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string' },
      },
    },
  },
  {
    name: 'ask_user',
    description:
      "Ask the human supervisor a question via the Dispatch app and block until they answer. The question and options surface as a `question_required` intervention strip in the workstream's detail view; the user picks an option (or types free text when allowed) and the answer comes back here. Use this instead of guessing when a decision genuinely needs the human in the loop.",
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          description: 'The question to surface to the manager.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Multiple-choice options. Render as buttons in Dispatch. Up to 8 strings. May be empty if `allow_freetext` is true.',
        },
        allow_freetext: {
          type: 'boolean',
          description:
            'When true, the manager may type a free-form answer in addition to / instead of picking an option. Defaults to false.',
        },
        context: {
          type: 'string',
          description:
            'Optional one-line context shown above the question (e.g. the tool the agent is about to call, the file under discussion).',
        },
        timeout_seconds: {
          type: 'number',
          minimum: 5,
          maximum: 3600,
          description:
            'How long to wait for an answer before returning `{answered:false, reason:"timeout"}`. Default 300 s. Capped at 1 h.',
        },
      },
    },
  },
  {
    name: 'propose_skill',
    description:
      'Propose a skill/pattern that should be promoted to the team handbook for all agents to read.',
    inputSchema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        source_decision_id: { type: 'string' },
      },
    },
  },
  {
    name: 'transition_ticket',
    description:
      "Move the linked tracker ticket (e.g. Linear issue) into a named workflow state and optionally post a Markdown comment with your reasoning. Use this to close the autonomous loop: when you're satisfied the work is complete and the PR is open, call transition_ticket with the team's 'done' state name. When you're blocked or want a human in the loop, call it with the team's 'needs review' state name. The tool resolves the workstream → tracker-link via DISPATCH_WORKSTREAM and 422s if the state name doesn't exist.",
    inputSchema: {
      type: 'object',
      required: ['state'],
      properties: {
        state: {
          type: 'string',
          description:
            "Target workflow state name as it appears in the tracker UI, e.g. 'In Review' / 'Done' / 'Needs Info'. Case-sensitive on Linear.",
        },
        comment: {
          type: 'string',
          description:
            'Optional Markdown comment posted on the issue before the state changes. Useful for explaining the transition (PR url, blocker, summary).',
        },
      },
    },
  },
  {
    name: 'open_pr',
    description:
      "Push the current branch and open a pull request. Wraps `git push -u origin HEAD` + `gh pr create --title --body`. Refuses to operate on `main`/`master`, refuses on a dirty working tree, refuses when `gh` isn't on PATH. Returns the PR url on success — pass it to transition_ticket's comment so the Linear issue links to the PR.",
    inputSchema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR body (Markdown).' },
        base: {
          type: 'string',
          description: "Base branch to merge into. Defaults to the repo's default branch.",
        },
      },
    },
  },
  {
    name: 'file_ticket',
    description:
      "File a brand-new tracker ticket (e.g. Linear) for work the agent surfaced but isn't doing inline. Routes through the long-running daemon's HTTP API so the tracker adapter (and its credentials) stay in one place. Returns the new ticket's identifier + url; surfaces the daemon's 4xx/5xx as an error result. Use sparingly — every call materializes a ticket.",
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Ticket title — keep it short and actionable.' },
        description: {
          type: 'string',
          description: 'Markdown body. Include any context the next responder needs.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lowercased label names. Unknown names are silently dropped.',
        },
        priority: {
          type: 'number',
          description: 'Linear-style priority: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low.',
        },
      },
    },
  },
];

export function buildMcpServer(opts: BuildOptions): Server {
  const { eventStore, memoryStore, registry, skillProposalsStore, interventionQueue } = opts;
  const askUserPollMs = opts.askUserPollMs ?? 1000;
  const askUserDefaultTimeoutSec = opts.askUserDefaultTimeoutSec ?? 300;
  const askUserMaxTimeoutSec = opts.askUserMaxTimeoutSec ?? 3600;
  const daemonUrl = opts.daemonUrl ?? `http://127.0.0.1:${process.env['DISPATCH_PORT'] ?? '8787'}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const server = new Server(
    {
      name: 'dispatch-daemon',
      version: '0.0.1',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: argsRaw } = req.params;
    const args = (argsRaw ?? {}) as Record<string, unknown>;
    const workstreamId = resolveWorkstreamId();
    const sessionId = resolveSessionId();
    // Make sure the workstream row exists — agents can call MCP tools before any
    // explicit `dispatch register`. ensure() is idempotent.
    registry.ensure(workstreamId);

    const ts = new Date().toISOString();
    const baseEvent = {
      ts,
      workstream_id: workstreamId,
      session_id: sessionId,
    } as const;

    const append = (type: ManagerEventType, payload: Record<string, unknown>): Promise<void> => {
      const ev: ManagerEvent = {
        ...baseEvent,
        type,
        id: `${type}_${randomUUID().slice(0, 8)}`,
        payload,
      };
      const parent = args['parent_id'];
      if (typeof parent === 'string') {
        ev.parent_id = parent;
      }
      return eventStore.appendEvent(workstreamId, ev);
    };

    switch (name) {
      case 'emit_decision': {
        await append('decision', {
          considered: args['considered'] ?? [],
          choice: args['choice'] ?? '',
          rationale: args['rationale'] ?? '',
          confidence: args['confidence'] ?? null,
        });
        return textResult('decision recorded');
      }
      case 'emit_subgoal': {
        await append('subgoal_push', { goal: args['goal'] ?? '' });
        return textResult('subgoal pushed');
      }
      case 'emit_confidence': {
        await append('confidence', { value: args['value'] ?? null, note: args['note'] ?? null });
        return textResult('confidence recorded');
      }
      case 'flag_blocked': {
        await append('blocked', { reason: args['reason'] ?? '' });
        return textResult('blocked flagged');
      }
      case 'update_memory': {
        const section = String(args['section'] ?? '');
        const content = String(args['content'] ?? '');
        if (!section) {
          return errorResult('section is required');
        }
        await memoryStore.updateSection(workstreamId, section, content);
        await append('memory_update', { section });
        return textResult(`memory section "${section}" updated`);
      }
      case 'read_memory': {
        const section = args['section'];
        if (typeof section === 'string' && section.length > 0) {
          const body = await memoryStore.readSection(workstreamId, section);
          return textResult(body ?? '');
        }
        const md = await memoryStore.read(workstreamId);
        return textResult(md);
      }
      case 'ask_user': {
        const question = String(args['question'] ?? '').trim();
        if (!question) return errorResult('question is required');
        const optionsRaw = args['options'];
        const options: string[] = Array.isArray(optionsRaw)
          ? optionsRaw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 8)
          : [];
        const allowFreetext = args['allow_freetext'] === true;
        if (options.length === 0 && !allowFreetext) {
          return errorResult(
            'either provide at least one option or set allow_freetext=true so the manager has a way to answer',
          );
        }
        const context =
          typeof args['context'] === 'string' && args['context'].length > 0
            ? (args['context'] as string)
            : undefined;
        const requestedTimeout =
          typeof args['timeout_seconds'] === 'number' && Number.isFinite(args['timeout_seconds'])
            ? Math.max(
                5,
                Math.min(askUserMaxTimeoutSec, Math.floor(args['timeout_seconds'] as number)),
              )
            : askUserDefaultTimeoutSec;

        const intervention = interventionQueue.enqueue(workstreamId, 'question_required', {
          question_request: {
            question,
            ...(options.length > 0 ? { options } : {}),
            ...(allowFreetext ? { allow_freetext: true } : {}),
            ...(context ? { context } : {}),
          },
        });
        // Mirror to the event log so per-workstream WS streams (and the
        // macOS QuestionStrip) see it without a separate poll path.
        await append('intervention_enqueued', {
          intervention_id: intervention.id,
          kind: intervention.kind,
        });

        const deadline = Date.now() + requestedTimeout * 1000;
        // Polling cadence is intentionally simple — the queue is a SQLite
        // table with WAL, and `get(id)` is one prepared statement. A 1 s
        // tick keeps the agent's reply latency under ~1 s after the manager
        // clicks an option without burning CPU.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const current = interventionQueue.get(intervention.id);
          if (current && current.delivered_at && current.payload.question_answer) {
            const ans = current.payload.question_answer;
            await append('intervention_delivered', {
              intervention_id: intervention.id,
              kind: intervention.kind,
              ...(ans.choice !== undefined ? { choice: ans.choice } : {}),
              ...(ans.freetext !== undefined ? { freetext: ans.freetext } : {}),
            });
            return textResult(
              JSON.stringify({
                answered: true,
                intervention_id: intervention.id,
                ...(ans.choice !== undefined ? { choice: ans.choice } : {}),
                ...(ans.freetext !== undefined ? { freetext: ans.freetext } : {}),
              }),
            );
          }
          if (Date.now() >= deadline) {
            return textResult(
              JSON.stringify({
                answered: false,
                reason: 'timeout',
                intervention_id: intervention.id,
                timeout_seconds: requestedTimeout,
              }),
            );
          }
          await new Promise((resolve) => setTimeout(resolve, askUserPollMs));
        }
      }
      case 'propose_skill': {
        const title = String(args['title'] ?? '');
        const body = String(args['body'] ?? '');
        if (!title) return errorResult('title is required');
        if (!body) return errorResult('body is required');
        const sourceDecisionId =
          typeof args['source_decision_id'] === 'string' && args['source_decision_id'].length > 0
            ? (args['source_decision_id'] as string)
            : undefined;
        const proposeArgs: {
          workstream_id: string;
          title: string;
          body: string;
          source_decision_id?: string;
        } = { workstream_id: workstreamId, title, body };
        if (sourceDecisionId) proposeArgs.source_decision_id = sourceDecisionId;
        const proposal = skillProposalsStore.propose(proposeArgs);
        const eventPayload: Record<string, unknown> = {
          proposal_id: proposal.id,
          title: proposal.title,
        };
        if (sourceDecisionId) eventPayload['source_decision_id'] = sourceDecisionId;
        await append('skill_proposed', eventPayload);
        return textResult(`skill proposed: ${proposal.id}`);
      }
      case 'transition_ticket': {
        const state = String(args['state'] ?? '').trim();
        if (!state) return errorResult('state is required');
        const comment = typeof args['comment'] === 'string' ? args['comment'] : null;
        const reqBody: Record<string, unknown> = {
          workstream_id: workstreamId,
          state,
        };
        if (comment) reqBody.comment = comment;
        let resp: Response;
        try {
          resp = await fetchImpl(`${daemonUrl}/trackers/transition`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(reqBody),
          });
        } catch (err) {
          return errorResult(
            `daemon unreachable at ${daemonUrl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const text = await resp.text();
        if (!resp.ok) {
          return errorResult(`daemon HTTP ${resp.status}: ${text.slice(0, 300)}`);
        }
        // Mirror to event log so the Radar shows the state change.
        await append('decision', {
          considered: ['continue', 'transition_ticket'],
          choice: 'transition_ticket',
          rationale: `moved ticket to "${state}"${comment ? `: ${comment.slice(0, 100)}` : ''}`,
          confidence: 0.9,
        });
        return textResult(text);
      }
      case 'open_pr': {
        const title = String(args['title'] ?? '').trim();
        const body = String(args['body'] ?? '');
        if (!title) return errorResult('title is required');
        if (!body) return errorResult('body is required');
        const base = typeof args['base'] === 'string' ? args['base'] : null;
        const cwd = process.cwd();
        const result = await openPullRequest({
          cwd,
          title,
          body,
          ...(base ? { base } : {}),
          spawnImpl: opts.openPrSpawnImpl,
        });
        if (!result.ok) {
          return errorResult(result.error ?? 'open_pr failed');
        }
        await append('decision', {
          considered: ['stop', 'open_pr'],
          choice: 'open_pr',
          rationale: `opened PR ${result.url ?? '(url unavailable)'}: ${title.slice(0, 100)}`,
          confidence: 0.95,
        });
        return textResult(JSON.stringify({ ok: true, url: result.url, branch: result.branch }));
      }
      case 'file_ticket': {
        const title = String(args['title'] ?? '').trim();
        if (!title) return errorResult('title is required');
        const body: Record<string, unknown> = { title };
        if (typeof args['description'] === 'string') body.description = args['description'];
        if (Array.isArray(args['labels'])) {
          body.labels = (args['labels'] as unknown[]).filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          );
        }
        if (typeof args['priority'] === 'number') body.priority = args['priority'];
        let resp: Response;
        try {
          resp = await fetchImpl(`${daemonUrl}/trackers/issues`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (err) {
          return errorResult(
            `daemon unreachable at ${daemonUrl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const text = await resp.text();
        if (!resp.ok) {
          return errorResult(`daemon HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        // Mirror to the event log so the Radar shows the agent filed a ticket.
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // body isn't JSON — surface raw text and skip event mirror.
        }
        if (typeof parsed['identifier'] === 'string') {
          await append('decision', {
            considered: ['inline_fix', 'file_ticket'],
            choice: 'file_ticket',
            rationale: `filed ${parsed['identifier']}: ${title.slice(0, 100)}`,
            confidence: 0.9,
          });
        }
        return textResult(text);
      }
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  });

  return server;
}

function textResult(text: string) {
  return {
    content: [{ type: 'text', text } as const],
  };
}

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: 'text', text } as const],
  };
}

/**
 * v1.4.17 — Open a PR for the current branch in `cwd`. Wraps
 * `git push -u origin <branch>` + `gh pr create --title --body --base?`.
 * Refuses on:
 *
 *   - Branch is `main` / `master` (would push to default branch).
 *   - Working tree dirty (uncommitted changes).
 *   - `gh` CLI missing (ENOENT-ish).
 *
 * Returns `{ok, url, branch}` on success; `{ok:false, error}` otherwise.
 */
export interface OpenPrInput {
  cwd: string;
  title: string;
  body: string;
  base?: string;
  spawnImpl?: OpenPrSpawn;
}

export interface OpenPrResult {
  ok: boolean;
  url?: string;
  branch?: string;
  error?: string;
}

const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk']);

export async function openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
  const spawnImpl = input.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
  // 1) Resolve current branch.
  const branchResult = await runCmd(spawnImpl, 'git', [
    '-C',
    input.cwd,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  if (branchResult.code !== 0) {
    return { ok: false, error: `git rev-parse failed: ${branchResult.output.slice(0, 200)}` };
  }
  const branch = branchResult.output.trim();
  if (!branch) return { ok: false, error: 'could not resolve current branch' };
  if (PROTECTED_BRANCHES.has(branch)) {
    return {
      ok: false,
      branch,
      error: `refusing to open a PR from protected branch "${branch}"`,
    };
  }
  // 2) Refuse on dirty tree.
  const statusResult = await runCmd(spawnImpl, 'git', ['-C', input.cwd, 'status', '--porcelain']);
  if (statusResult.code !== 0) {
    return { ok: false, branch, error: `git status failed: ${statusResult.output.slice(0, 200)}` };
  }
  if (statusResult.output.trim().length > 0) {
    return {
      ok: false,
      branch,
      error: `working tree has uncommitted changes — commit or stash before opening PR`,
    };
  }
  // 3) Push.
  const pushResult = await runCmd(spawnImpl, 'git', [
    '-C',
    input.cwd,
    'push',
    '-u',
    'origin',
    branch,
  ]);
  if (pushResult.code !== 0) {
    return { ok: false, branch, error: `git push failed: ${pushResult.output.slice(-400)}` };
  }
  // 4) gh pr create. Detect missing gh via ENOENT in output.
  const ghArgs = ['pr', 'create', '--title', input.title, '--body', input.body];
  if (input.base) ghArgs.push('--base', input.base);
  const prResult = await runCmd(spawnImpl, 'gh', ghArgs, { cwd: input.cwd });
  if (prResult.code !== 0) {
    const lower = prResult.output.toLowerCase();
    if (lower.includes('enoent') || lower.includes('command not found')) {
      return {
        ok: false,
        branch,
        error: `gh CLI not found on PATH. Install from https://cli.github.com (output: ${prResult.output.slice(0, 200)})`,
      };
    }
    return { ok: false, branch, error: `gh pr create failed: ${prResult.output.slice(-400)}` };
  }
  // gh prints the PR url on stdout (last line).
  const url = prResult.output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('http'));
  return { ok: true, branch, ...(url ? { url } : {}) };
}

interface RunCmdResult {
  code: number | null;
  output: string;
}

function runCmd(
  spawnImpl: OpenPrSpawn,
  cmd: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<RunCmdResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // ENOENT on the spawn itself (cmd not on PATH).
      resolve({ code: null, output: msg });
      return;
    }
    const chunks: Buffer[] = [];
    const onData = (b: Buffer): void => {
      chunks.push(b);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      resolve({
        code: null,
        output: err instanceof Error ? err.message : String(err),
      });
    });
    child.on('close', (code) => {
      resolve({
        code: typeof code === 'number' ? code : null,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

/** Connects the MCP server over stdio. Caller awaits the returned promise. */
export async function startMcpStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
