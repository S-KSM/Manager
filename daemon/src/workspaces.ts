import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * WorkspaceManager — Symphony SPEC.md §9.
 *
 * Owns the on-disk workspace dir per issue. Enforces the three safety
 * invariants from §9.5:
 *
 *   1. The agent runner only ever runs with `cwd == workspace_path`.
 *   2. `workspace_path` MUST be inside `workspace_root`.
 *   3. The workspace key is sanitized: `[A-Za-z0-9._-]` only — anything else
 *      is replaced with `_`.
 *
 * Hooks (`after_create` / `before_run` / `after_run` / `before_remove`) run via
 * `bash -lc <script>` with `hooks.timeout_ms` (default 60s). Failure semantics
 * follow §9.4: `after_create` and `before_run` failures are fatal; `after_run`
 * and `before_remove` failures are logged-but-ignored.
 *
 * Note: the orchestrator never touches the filesystem directly — every path
 * goes through this class. That keeps Symphony's "all spawn/runs are inside
 * the per-issue workspace" invariant easy to audit.
 */

export interface WorkspaceHooks {
  after_create?: string | null;
  before_run?: string | null;
  after_run?: string | null;
  before_remove?: string | null;
  timeout_ms?: number;
}

export interface WorkspaceManagerOptions {
  /** Symphony §5.3.3 workspace.root, normalized absolute. */
  root?: string;
  hooks?: WorkspaceHooks;
}

export interface PreparedWorkspace {
  /** Absolute filesystem path. */
  path: string;
  /** Sanitized key used for the directory name. */
  workspace_key: string;
  /** True iff the directory was created during this prepare() call (gates after_create). */
  created_now: boolean;
}

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const SAFE_KEY_RE = /[^A-Za-z0-9._-]/g;

export class WorkspaceManager {
  private root: string;
  private hooks: WorkspaceHooks;

  constructor(opts: WorkspaceManagerOptions = {}) {
    this.root = normalizeRoot(opts.root);
    this.hooks = opts.hooks ?? {};
  }

  /** Hot reload from a workflow change. */
  applyConfig(opts: Partial<WorkspaceManagerOptions>): void {
    if (opts.root) this.root = normalizeRoot(opts.root);
    if (opts.hooks) this.hooks = opts.hooks;
  }

  /** Computed workspace root (absolute). */
  getRoot(): string {
    return this.root;
  }

  /**
   * Symphony §9.2 algorithm. Idempotent: directory is reused when present;
   * `created_now=false` then.
   */
  async prepare(issueIdentifier: string): Promise<PreparedWorkspace> {
    const key = sanitizeKey(issueIdentifier);
    const path = this.assertInsideRoot(resolve(this.root, key));
    const exists = await dirExists(path);
    await mkdir(path, { recursive: true });
    const createdNow = !exists;
    if (createdNow && this.hooks.after_create) {
      await this.runHook('after_create', this.hooks.after_create, path, /* fatal */ true);
    }
    return { path, workspace_key: key, created_now: createdNow };
  }

  /** Symphony §9.4 — fatal on failure. Returns the workspace (caller usually has it). */
  async runBeforeRun(workspacePath: string): Promise<void> {
    this.assertInsideRoot(workspacePath);
    if (!this.hooks.before_run) return;
    await this.runHook('before_run', this.hooks.before_run, workspacePath, /* fatal */ true);
  }

  /** Symphony §9.4 — failure logged-only. */
  async runAfterRun(workspacePath: string): Promise<void> {
    if (!this.hooks.after_run) return;
    if (!(await dirExists(workspacePath))) return;
    await this.runHook('after_run', this.hooks.after_run, workspacePath, /* fatal */ false);
  }

  /** Symphony §9.4 + §8.6 — runs `before_remove`, then deletes the dir. */
  async remove(issueIdentifier: string): Promise<void> {
    const key = sanitizeKey(issueIdentifier);
    const path = this.assertInsideRoot(resolve(this.root, key));
    if (!(await dirExists(path))) return;
    if (this.hooks.before_remove) {
      await this.runHook('before_remove', this.hooks.before_remove, path, /* fatal */ false);
    }
    await rm(path, { recursive: true, force: true });
  }

  /**
   * Symphony §9.5 invariant 2 — every path the orchestrator touches must
   * resolve under `root`. Throws on violation.
   */
  assertInsideRoot(absPath: string): string {
    if (!isAbsolute(absPath)) {
      throw new WorkspaceSafetyError(`workspace path not absolute: ${absPath}`);
    }
    const root = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (absPath !== this.root && !absPath.startsWith(root)) {
      throw new WorkspaceSafetyError(
        `workspace path ${absPath} is outside root ${this.root}`,
      );
    }
    return absPath;
  }

  private async runHook(
    name: string,
    script: string,
    cwd: string,
    fatal: boolean,
  ): Promise<void> {
    const timeoutMs = this.hooks.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;
    try {
      await execScript(script, cwd, timeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[dispatch] workspace hook ${name} failed: ${msg}\n`);
      if (fatal) {
        throw new WorkspaceHookError(name, msg);
      }
    }
  }
}

/** Symphony §9.5 invariant 3 sanitization. */
export function sanitizeKey(identifier: string): string {
  const cleaned = identifier.replace(SAFE_KEY_RE, '_');
  // Collapse leading/trailing underscores to keep names tidy without breaking the spec rule.
  return cleaned.replace(/^_+|_+$/g, '') || '_';
}

function normalizeRoot(root?: string): string {
  if (!root) {
    return resolve(tmpdir(), 'dispatch_workspaces');
  }
  let r = root;
  if (r.startsWith('~')) {
    r = r.replace(/^~/, homedir());
  }
  return resolve(r);
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Run a multi-line shell script via `bash -lc`. Resolves on exit 0; rejects
 * on non-zero, non-existent shell, or timeout.
 */
function execScript(script: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('bash', ['-lc', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      rejectP(new Error(`hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP();
      else rejectP(new Error(`hook exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

export class WorkspaceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSafetyError';
  }
}

export class WorkspaceHookError extends Error {
  constructor(
    public readonly hook: string,
    message: string,
  ) {
    super(`workspace hook "${hook}" failed: ${message}`);
    this.name = 'WorkspaceHookError';
  }
}
