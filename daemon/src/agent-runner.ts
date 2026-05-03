import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Issue } from './trackers/index.js';
import type { WorkspaceManager } from './workspaces.js';

/**
 * AgentRunner — Symphony SPEC.md §10 (Agent Runner Protocol), adapted for
 * Claude Code instead of Codex.
 *
 * v1.4.2 ships option **A** from the plan: spawn `claude` as a one-shot
 * subprocess per turn (no app-server bridge). Stdout from `claude --print
 * --output-format stream-json` is line-delimited JSON we can drain into the
 * orchestrator's outcome decision; stderr is forwarded to the daemon log.
 *
 * Telemetry (decision/subgoal/tool_use events) keeps flowing through the
 * existing `hooks/` shell scripts that Claude Code already invokes — the
 * spawn here just sets the right env vars (`DISPATCH_WORKSTREAM`,
 * `DISPATCH_SESSION_ID`) so those hooks land on the right workstream.
 */

export interface AgentRunOptions {
  /** Per-spawn `cwd`. MUST be the prepared workspace path. */
  workspacePath: string;
  /** Issue we're working on; used for env vars + log context. */
  issue: Issue;
  /** Symphony §7.1 attempt counter (null = first turn). */
  attempt: number | null;
  /** Rendered prompt (workflow template + issue context). */
  prompt: string;
  /** Symphony §5.3.6 turn timeout. */
  turnTimeoutMs?: number;
  /**
   * Custom command override. Default: `claude --print --output-format stream-json`.
   * Single string passed to `bash -lc` so users can shell-quote however they like.
   */
  command?: string;
  /** Env override map merged into process.env for the spawn. */
  env?: Record<string, string | undefined>;
  /** Extra workstream id; defaults to sanitized issue identifier (caller usually passes the orchestrator's mapping). */
  workstreamId: string;
  /** Optional logger; defaults to stderr.write. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface AgentRunResult {
  /** True iff the process exited 0 within turnTimeoutMs. */
  ok: boolean;
  /** Process exit code (or null on signal). */
  exitCode: number | null;
  /** Optional normalized error category (Symphony §10.6) when !ok. */
  error?:
    | 'turn_timeout'
    | 'turn_failed'
    | 'codex_not_found'
    | 'invalid_workspace_cwd'
    | 'spawn_error';
  /** Newline-delimited stderr captured during the run, capped at 4 KB. */
  stderr_tail: string;
  /** Generated session id we set as DISPATCH_SESSION_ID for hook routing. */
  session_id: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1_000; // 1 hour, matches Symphony §5.3.6
const DEFAULT_COMMAND = 'claude --print --output-format stream-json';
const STDERR_CAP_BYTES = 4 * 1024;

export class AgentRunner {
  private readonly workspaces: WorkspaceManager;
  constructor(workspaces: WorkspaceManager) {
    this.workspaces = workspaces;
  }

  /**
   * Run one turn: prepare workspace pre-flight, spawn `claude`, await exit
   * (or timeout). Returns a normalized result; the orchestrator translates
   * `{ok: true}` into a continuation retry and `{ok: false}` into an
   * exp-backoff retry.
   */
  async runTurn(opts: AgentRunOptions): Promise<AgentRunResult> {
    // Symphony §9.5 invariant 1+2 — re-assert before spawn.
    this.workspaces.assertInsideRoot(opts.workspacePath);

    await this.workspaces.runBeforeRun(opts.workspacePath);

    const sessionId = `sess_${randomUUID().slice(0, 8)}`;
    const command = opts.command ?? DEFAULT_COMMAND;
    const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const log = opts.log ?? ((m: string, ctx?: Record<string, unknown>) =>
      process.stderr.write(`[dispatch] ${m}${ctx ? ' ' + JSON.stringify(ctx) : ''}\n`));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      DISPATCH_WORKSTREAM: opts.workstreamId,
      DISPATCH_SESSION_ID: sessionId,
    };

    log('agent_runner.spawn', {
      issue: opts.issue.identifier,
      attempt: opts.attempt,
      cwd: opts.workspacePath,
      session_id: sessionId,
    });

    let child: ChildProcess;
    try {
      child = spawn('bash', ['-lc', command], {
        cwd: opts.workspacePath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const result: AgentRunResult = {
        ok: false,
        exitCode: null,
        error: 'spawn_error',
        stderr_tail: err instanceof Error ? err.message : String(err),
        session_id: sessionId,
      };
      await this.workspaces.runAfterRun(opts.workspacePath);
      return result;
    }

    // Pipe prompt to stdin and close.
    child.stdin?.end(opts.prompt, 'utf8');

    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_CAP_BYTES) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    // We currently drain stdout but don't parse it — hooks already ship the
    // structured events to the daemon. Keeping the stream consumed prevents
    // backpressure killing the child on long runs.
    child.stdout?.on('data', () => undefined);

    const result = await new Promise<AgentRunResult>((resolveP) => {
      let resolved = false;
      const finalize = (r: AgentRunResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolveP(r);
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, 5_000).unref();
        } catch {
          // ignore
        }
        finalize({
          ok: false,
          exitCode: null,
          error: 'turn_timeout',
          stderr_tail: Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_CAP_BYTES),
          session_id: sessionId,
        });
      }, turnTimeoutMs);
      child.on('error', (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        finalize({
          ok: false,
          exitCode: null,
          error: msg.includes('ENOENT') ? 'codex_not_found' : 'spawn_error',
          stderr_tail: msg,
          session_id: sessionId,
        });
      });
      child.on('close', (code) => {
        const stderrTail = Buffer.concat(stderrChunks)
          .toString('utf8')
          .slice(0, STDERR_CAP_BYTES);
        if (code === 0) {
          finalize({ ok: true, exitCode: 0, stderr_tail: stderrTail, session_id: sessionId });
        } else {
          finalize({
            ok: false,
            exitCode: code,
            error: 'turn_failed',
            stderr_tail: stderrTail,
            session_id: sessionId,
          });
        }
      });
    });

    // Symphony §9.4 — after_run regardless of outcome.
    await this.workspaces.runAfterRun(opts.workspacePath);
    log('agent_runner.exit', {
      issue: opts.issue.identifier,
      ok: result.ok,
      exit: result.exitCode,
      error: result.error,
    });
    return result;
  }
}
