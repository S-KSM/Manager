import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Issue } from './trackers/index.js';
import type { WorkspaceManager } from './workspaces.js';
import type { EventStore } from './event-store.js';

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
 *
 * `runtime: 'claude-code-tmux'` (claude-fleet integration) is a second
 * spawn strategy: instead of a headless one-shot subprocess, it opens the
 * workspace in a detached tmux pane a human can attach to mid-flight
 * (`tmux attach -t dispatch-<workstream>-<session>`). tmux gives no exit
 * code for "the agent finished its turn" the way a subprocess does, so
 * completion is instead detected by tailing the event store for the
 * `session_end` `ManagerEvent` the `Stop` hook writes for this run's
 * `DISPATCH_SESSION_ID` — the same signal headless mode gets for free from
 * the process exiting. This means the tmux runtime only works in a
 * workspace with Dispatch's hooks installed, and requires the daemon to
 * construct this runner with an `EventStore` (see constructor). One tmux
 * session is created per turn (mirroring one subprocess per turn in
 * headless mode) and killed when the turn resolves, success or timeout —
 * it is not left running for later turns to reuse.
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
  /**
   * `claude-code` (default) and `codex` both spawn `command` as a one-shot
   * subprocess and wait for its exit. `claude-code-tmux` instead opens the
   * workspace in a detached tmux pane and waits for the Stop hook's
   * `session_end` event for this run's `DISPATCH_SESSION_ID` — see the class
   * doc comment. Requires the runner to have been constructed with an
   * `EventStore`.
   */
  runtime?: 'claude-code' | 'codex' | 'claude-code-tmux';
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
    | 'spawn_error'
    | 'missing_event_store';
  /** Newline-delimited stderr captured during the run, capped at 4 KB. */
  stderr_tail: string;
  /** Generated session id we set as DISPATCH_SESSION_ID for hook routing. */
  session_id: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1_000; // 1 hour, matches Symphony §5.3.6
const DEFAULT_COMMAND = 'claude --print --output-format stream-json';
/** Interactive REPL, not `--print` — a human may be watching the pane. */
const DEFAULT_TMUX_COMMAND = 'claude';
const STDERR_CAP_BYTES = 4 * 1024;
/** Setup/teardown tmux CLI calls should return near-instantly; anything longer means tmux itself is wedged. */
const TMUX_CONTROL_TIMEOUT_MS = 15_000;

/** A tmux pane currently hosting an in-flight `claude-code-tmux` turn. */
export interface ActiveTmuxSession {
  workstream_id: string;
  issue_identifier: string;
  session_id: string;
  tmux_session: string;
  /** Paste-ready: `tmux attach -t <tmux_session>`. */
  attach_command: string;
  started_at: string;
}

export class AgentRunner {
  private readonly workspaces: WorkspaceManager;
  private readonly eventStore?: EventStore;
  private readonly activeTmux = new Map<string, ActiveTmuxSession>();

  /** In-flight tmux panes keyed by workstream — surfaced via `GET /orchestrator/state` so the Radar can offer "Attach". */
  activeTmuxSessions(): ActiveTmuxSession[] {
    return [...this.activeTmux.values()];
  }

  /** `eventStore` is required to use `runtime: 'claude-code-tmux'` — see class doc comment. */
  constructor(workspaces: WorkspaceManager, eventStore?: EventStore) {
    this.workspaces = workspaces;
    this.eventStore = eventStore;
  }

  /**
   * Run one turn: prepare workspace pre-flight, spawn the agent (subprocess
   * or tmux pane per `opts.runtime`), await completion (or timeout). Returns
   * a normalized result; the orchestrator translates `{ok: true}` into a
   * continuation retry and `{ok: false}` into an exp-backoff retry.
   */
  async runTurn(opts: AgentRunOptions): Promise<AgentRunResult> {
    // Symphony §9.5 invariant 1+2 — re-assert before spawn.
    this.workspaces.assertInsideRoot(opts.workspacePath);

    await this.workspaces.runBeforeRun(opts.workspacePath);

    const sessionId = `sess_${randomUUID().slice(0, 8)}`;
    const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const log =
      opts.log ??
      ((m: string, ctx?: Record<string, unknown>) =>
        process.stderr.write(`[dispatch] ${m}${ctx ? ' ' + JSON.stringify(ctx) : ''}\n`));

    const result =
      opts.runtime === 'claude-code-tmux'
        ? await this.runTmuxTurn(opts, sessionId, turnTimeoutMs, log)
        : await this.runSubprocessTurn(opts, sessionId, turnTimeoutMs, log);

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

  private async runSubprocessTurn(
    opts: AgentRunOptions,
    sessionId: string,
    turnTimeoutMs: number,
    log: (msg: string, ctx?: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    const command = opts.command ?? DEFAULT_COMMAND;
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
      return {
        ok: false,
        exitCode: null,
        error: 'spawn_error',
        stderr_tail: err instanceof Error ? err.message : String(err),
        session_id: sessionId,
      };
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
        const stderrTail = Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_CAP_BYTES);
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

    return result;
  }

  /**
   * `claude-code-tmux` runtime: open the workspace in a detached tmux pane,
   * send the prompt, then wait for the `Stop` hook's `session_end` event for
   * this run's `sessionId` (via `EventStore.tailEvents`) instead of a process
   * exit code. Kills the tmux session when the turn resolves either way.
   */
  private async runTmuxTurn(
    opts: AgentRunOptions,
    sessionId: string,
    turnTimeoutMs: number,
    log: (msg: string, ctx?: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    if (!this.eventStore) {
      return {
        ok: false,
        exitCode: null,
        error: 'missing_event_store',
        stderr_tail:
          'runtime: claude-code-tmux requires AgentRunner to be constructed with an EventStore',
        session_id: sessionId,
      };
    }
    const eventStore = this.eventStore;
    const command = opts.command ?? DEFAULT_TMUX_COMMAND;
    const tmuxSession = `dispatch-${sanitizeTmuxToken(opts.workstreamId)}-${sessionId}`;
    const paneEnv = `export DISPATCH_WORKSTREAM=${shQuote(opts.workstreamId)} DISPATCH_SESSION_ID=${shQuote(sessionId)};`;

    log('agent_runner.tmux_spawn', {
      issue: opts.issue.identifier,
      attempt: opts.attempt,
      cwd: opts.workspacePath,
      session_id: sessionId,
      tmux_session: tmuxSession,
    });

    const create = await runShellControl(
      `tmux new-session -d -s ${shQuote(tmuxSession)} -c ${shQuote(opts.workspacePath)} ${shQuote(`${paneEnv} ${command}`)}`,
      opts.workspacePath,
    );
    if (!create.ok) {
      return {
        ok: false,
        exitCode: null,
        error: 'spawn_error',
        stderr_tail: create.stderr,
        session_id: sessionId,
      };
    }

    const send = await runShellControl(
      `tmux send-keys -t ${shQuote(tmuxSession)} ${shQuote(opts.prompt)} C-m`,
      opts.workspacePath,
    );
    if (!send.ok) {
      await runShellControl(`tmux kill-session -t ${shQuote(tmuxSession)}`, opts.workspacePath);
      return {
        ok: false,
        exitCode: null,
        error: 'spawn_error',
        stderr_tail: send.stderr,
        session_id: sessionId,
      };
    }

    this.activeTmux.set(opts.workstreamId, {
      workstream_id: opts.workstreamId,
      issue_identifier: opts.issue.identifier,
      session_id: sessionId,
      tmux_session: tmuxSession,
      attach_command: `tmux attach -t ${tmuxSession}`,
      started_at: new Date().toISOString(),
    });

    // Only watch events appended from here on — an older session_end for a
    // reused workstream (impossible session_id collision aside) must never
    // match.
    const { nextOffset: startOffset } = await eventStore.readEvents(opts.workstreamId);

    const result = await new Promise<AgentRunResult>((resolveP) => {
      let resolved = false;
      const finalize = (r: AgentRunResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        tail.close();
        resolveP(r);
      };
      const timer = setTimeout(() => {
        finalize({
          ok: false,
          exitCode: null,
          error: 'turn_timeout',
          stderr_tail: '',
          session_id: sessionId,
        });
      }, turnTimeoutMs);
      const tail = eventStore.tailEvents(opts.workstreamId, startOffset, (event) => {
        if (event.type === 'session_end' && event.session_id === sessionId) {
          finalize({ ok: true, exitCode: null, stderr_tail: '', session_id: sessionId });
        }
      });
    });

    // Symmetric with the subprocess path exiting: don't leave the pane
    // around for the next turn to collide with or the human to lose track of.
    this.activeTmux.delete(opts.workstreamId);
    await runShellControl(`tmux kill-session -t ${shQuote(tmuxSession)}`, opts.workspacePath);

    return result;
  }
}

/** Run a short tmux control command (create/send-keys/kill) and wait for its exit. */
async function runShellControl(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolveP) => {
    let child: ChildProcess;
    try {
      child = spawn('bash', ['-lc', command], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolveP({ ok: false, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolveP({ ok: false, stderr: `tmux control command timed out: ${command}` });
    }, TMUX_CONTROL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ ok: false, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({
        ok: code === 0,
        stderr: Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_CAP_BYTES),
      });
    });
  });
}

/** tmux session/window names reject a handful of punctuation chars; keep this conservative. */
function sanitizeTmuxToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
}

/** POSIX single-quote shell escaping for building `bash -lc` command strings. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
