import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolved daemon configuration. Computed lazily so tests can override
 * `DISPATCH_HOME` / `DISPATCH_PORT` via env before importing other modules.
 */
export interface DaemonConfig {
  /** Root state dir, default `~/.claude/dispatch`. Overridable with `DISPATCH_HOME` (legacy `MANAGER_HOME` honored for one release). */
  readonly home: string;
  /** Append-only event JSONL files, one per workstream. */
  readonly eventsDir: string;
  /** Markdown memory files, one per workstream. */
  readonly memoryDir: string;
  /** Per-workstream intervention queue files (v0.5+). */
  readonly queuesDir: string;
  /** SQLite registry of workstreams + sessions. */
  readonly dbPath: string;
  /** HTTP/WS port. Default 9876, overridable with `DISPATCH_PORT`. */
  readonly httpPort: number;
}

const DEFAULT_PORT = 9876;

/**
 * v1.2 backwards-compat env helper. Reads `DISPATCH_*` first; falls back to
 * `MANAGER_*` with a one-time stderr deprecation breadcrumb. The `MANAGER_*`
 * fallback is removed in v1.3 — see docs/ROADMAP.md.
 */
const warnedDeprecatedEnv = new Set<string>();
export function readEnvWithLegacy(newName: string, legacyName: string): string | undefined {
  const fresh = process.env[newName];
  if (fresh !== undefined) return fresh;
  const legacy = process.env[legacyName];
  if (legacy !== undefined) {
    if (!warnedDeprecatedEnv.has(legacyName)) {
      warnedDeprecatedEnv.add(legacyName);
      // The "X" is the suffix shared by both names (e.g. PORT in MANAGER_PORT / DISPATCH_PORT).
      const suffix = legacyName.replace(/^MANAGER_/, '');
      process.stderr.write(
        `dispatch: deprecation — MANAGER_${suffix} env var is read for backwards-compat; rename to DISPATCH_${suffix} by v1.3.\n`,
      );
    }
    return legacy;
  }
  return undefined;
}

let warnedStaleStateDir = false;

export function getConfig(): DaemonConfig {
  const defaultHome = join(homedir(), '.claude', 'dispatch');
  const home = readEnvWithLegacy('DISPATCH_HOME', 'MANAGER_HOME') ?? defaultHome;
  const portRaw = readEnvWithLegacy('DISPATCH_PORT', 'MANAGER_PORT');
  const httpPort = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (Number.isNaN(httpPort) || httpPort <= 0) {
    throw new Error(`Invalid DISPATCH_PORT: ${portRaw}`);
  }

  // One-line warning at boot if only the legacy state dir exists. We do NOT
  // auto-migrate from the daemon — that's `bin/install.sh`'s job (atomic mv).
  if (!warnedStaleStateDir && home === defaultHome) {
    const legacyHome = join(homedir(), '.claude', 'manager');
    if (existsSync(legacyHome) && !existsSync(defaultHome)) {
      warnedStaleStateDir = true;
      process.stderr.write(
        `dispatch: legacy state dir ${legacyHome} found but ${defaultHome} does not exist. Run bin/install.sh to migrate.\n`,
      );
    }
  }

  return {
    home,
    eventsDir: join(home, 'events'),
    memoryDir: join(home, 'memory'),
    queuesDir: join(home, 'queues'),
    dbPath: join(home, 'db.sqlite'),
    httpPort,
  };
}
