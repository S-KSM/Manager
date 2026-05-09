import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { exec } from 'node:child_process';

/**
 * v1.4.6 Diagnostics — pure helpers for the kill / restart endpoints.
 *
 * The macOS Diagnostics tab calls into these via three POST endpoints
 * (`/admin/llm/kill`, `/admin/llm/restart`, `/admin/restart`). Each helper is
 * factored to take an injectable side-effect (exec / process / spawn) so unit
 * tests can drive every branch without touching real PIDs or shelling out.
 *
 * macOS-only — the kill flow uses `lsof -i tcp:<port>`, which is part of the
 * base system on every supported macOS version. The daemon already targets
 * macOS as its only first-class runtime, so a Linux/Windows port is
 * out-of-scope here.
 */

export interface ParsedHostPort {
  host: string;
  port: number;
}

/**
 * Parse `host` + `port` out of a base URL like
 * `http://localhost:8080/v1`. Returns `null` for unparseable inputs.
 *
 * Port-of-port-omitted defaults match the URL-spec defaults: `http://` → 80,
 * `https://` → 443. The `/v1` suffix the rest of the codebase loves is
 * irrelevant to the host:port we're killing — `lsof` only cares about the
 * TCP port the process is listening on.
 */
export function parseHostPort(baseUrl: string): ParsedHostPort | null {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = u.hostname;
  if (!host) return null;
  let port = Number.parseInt(u.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    if (u.protocol === 'https:') port = 443;
    else if (u.protocol === 'http:') port = 80;
    else return null;
  }
  return { host, port };
}

/**
 * Injectable shell-exec; defaults to wrapping `child_process.exec` in a
 * Promise. Tests pass a stub returning canned stdout / stderr so we don't
 * actually shell out on CI.
 */
export type ExecImpl = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecImpl = (cmd: string) =>
  new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      // We deliberately swallow non-zero exit codes — `lsof -t` exits 1 when
      // nothing is listening, which is a normal "no PID found" case for us.
      void err;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/**
 * Find the PID(s) of the current user's processes listening on `port`.
 * Returns an empty array when nothing is listening.
 *
 * Uses `lsof -i tcp:<port> -sTCP:LISTEN -t`. The `-t` flag asks lsof for
 * "terse" output: PIDs only, one per line. We filter to numeric PIDs only
 * to defend against the edge case where lsof emits a warning to stdout.
 */
export async function findPidOnPort(
  port: number,
  opts: { execImpl?: ExecImpl } = {},
): Promise<number[]> {
  if (!Number.isFinite(port) || port <= 0) return [];
  const execImpl = opts.execImpl ?? defaultExec;
  const { stdout } = await execImpl(`lsof -i tcp:${port} -sTCP:LISTEN -t`);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Wrap `process.kill` so tests can swap it out. Returns true on success,
 * false when the kill threw (most commonly ESRCH = process already gone,
 * which we treat as "fine, kill didn't apply"; or EPERM = wrong user).
 */
export type ProcessKillImpl = (pid: number, signal: string | number) => void;

export function killPid(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  opts: { processImpl?: ProcessKillImpl } = {},
): boolean {
  const impl = opts.processImpl ?? ((p: number, s: string | number) => process.kill(p, s));
  try {
    impl(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether `pid` is still alive. Wraps `process.kill(pid, 0)` —
 * a no-op signal that throws ESRCH when the process is gone.
 */
export function isAlive(pid: number, opts: { processImpl?: ProcessKillImpl } = {}): boolean {
  const impl = opts.processImpl ?? ((p: number, s: string | number) => process.kill(p, s));
  try {
    impl(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface KillEscalationResult {
  /** True if SIGTERM didn't take and we had to escalate to SIGKILL. */
  escalated: boolean;
  /** True if the process is gone after our attempt(s). */
  dead: boolean;
}

/**
 * Send SIGTERM, wait `sleepMs` (default 3000), and if the process is still
 * around, escalate to SIGKILL. Returns the disposition.
 *
 * `sleepImpl` is injectable so the http-server test can collapse the 3s grace
 * period without skipping the escalation branch.
 */
export async function killWithEscalation(
  pid: number,
  opts: {
    sleepMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
    killImpl?: ProcessKillImpl;
    isAliveImpl?: (pid: number) => boolean;
  } = {},
): Promise<KillEscalationResult> {
  const sleepMs = opts.sleepMs ?? 3000;
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const killImpl = opts.killImpl;
  const isAliveImpl =
    opts.isAliveImpl ?? ((p: number) => isAlive(p, killImpl ? { processImpl: killImpl } : {}));

  const sentTerm = killPid(pid, 'SIGTERM', killImpl ? { processImpl: killImpl } : {});
  if (!sentTerm) {
    // SIGTERM threw — most often ESRCH (already gone) or EPERM. Treat ESRCH
    // as "dead", treat EPERM as "we can't kill it"; we conservatively report
    // dead = !isAlive() so EPERM surfaces as escalated:false, dead:false.
    return { escalated: false, dead: !isAliveImpl(pid) };
  }
  await sleepImpl(sleepMs);
  if (!isAliveImpl(pid)) {
    return { escalated: false, dead: true };
  }
  killPid(pid, 'SIGKILL', killImpl ? { processImpl: killImpl } : {});
  return { escalated: true, dead: !isAliveImpl(pid) };
}

export interface SpawnDetachedResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/**
 * Injectable spawn; defaults to `child_process.spawn`. Tests inject a stub
 * that either returns a fake `ChildProcess` or throws.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Run a shell command in the background, fully detached from the daemon's
 * process group. The command is passed to `bash -lc <cmd>` so the user can
 * lean on their normal login shell (PATH, conda activate, mlx env vars).
 *
 * `unref()` is what makes the daemon free to exit/restart while the
 * spawned process keeps running.
 */
export async function spawnDetached(
  command: string,
  opts: { spawnImpl?: SpawnImpl } = {},
): Promise<SpawnDetachedResult> {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { ok: false, error: 'empty command' };
  }
  const spawnImpl = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
  try {
    const child = spawnImpl('bash', ['-lc', command], { detached: true, stdio: 'ignore' });
    if (typeof child.unref === 'function') {
      try {
        child.unref();
      } catch {
        // ignore — best-effort, the spawn succeeded
      }
    }
    const pid = typeof child.pid === 'number' ? child.pid : undefined;
    return pid !== undefined ? { ok: true, pid } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * v1.4.13 — Pull a model into the local LLM runtime. Currently delegates to
 * `ollama pull <model>` since Ollama is the dominant local runtime that
 * supports a pull command. mlx_lm.server / llama.cpp don't have an
 * equivalent (they fetch from HuggingFace on first inference); for those the
 * caller is expected to surface a friendlier "no pull needed" message.
 *
 * Synchronous: waits for the pull to finish before resolving so the UI can
 * show a final "done" state. Captures stdout + stderr (truncated to keep the
 * HTTP response small — Ollama's pull output is verbose progress bars).
 */
export interface PullModelResult {
  ok: boolean;
  exit_code: number | null;
  /** Last ~4 KB of combined stdout+stderr. Useful for surfacing errors in the UI. */
  output: string;
  error?: string;
}

const PULL_OUTPUT_TAIL_BYTES = 4096;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

export async function pullOllamaModel(
  model: string,
  opts: { spawnImpl?: SpawnImpl } = {},
): Promise<PullModelResult> {
  const trimmed = model.trim();
  if (!MODEL_NAME_PATTERN.test(trimmed)) {
    return {
      ok: false,
      exit_code: null,
      output: '',
      error: `invalid model name: must match ${MODEL_NAME_PATTERN.source}`,
    };
  }
  const spawnImpl = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
  return await new Promise<PullModelResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl('ollama', ['pull', trimmed], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        ok: false,
        exit_code: null,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const onData = (buf: Buffer): void => {
      chunks.push(buf);
      totalBytes += buf.length;
      // Keep at most 2× the tail size in memory so a multi-GB pull's progress
      // output can't blow up the daemon. We slice down to `tail` on resolve.
      while (totalBytes > PULL_OUTPUT_TAIL_BYTES * 2 && chunks.length > 1) {
        const removed = chunks.shift();
        if (removed) totalBytes -= removed.length;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      // ENOENT here means `ollama` isn't on PATH — surface a clear hint.
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        exit_code: null,
        output: Buffer.concat(chunks).toString('utf8').slice(-PULL_OUTPUT_TAIL_BYTES),
        error: msg.includes('ENOENT') ? `ollama CLI not found on PATH: ${msg}` : msg,
      });
    });
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8').slice(-PULL_OUTPUT_TAIL_BYTES);
      resolve({
        ok: code === 0,
        exit_code: typeof code === 'number' ? code : null,
        output: out,
      });
    });
  });
}
