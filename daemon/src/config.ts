import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolved daemon configuration. Computed lazily so tests can override
 * `MANAGER_HOME` / `MANAGER_PORT` via env before importing other modules.
 */
export interface DaemonConfig {
  /** Root state dir, default `~/.claude/manager`. Overridable with `MANAGER_HOME`. */
  readonly home: string;
  /** Append-only event JSONL files, one per workstream. */
  readonly eventsDir: string;
  /** Markdown memory files, one per workstream. */
  readonly memoryDir: string;
  /** Per-workstream intervention queue files (v0.5+). */
  readonly queuesDir: string;
  /** SQLite registry of workstreams + sessions. */
  readonly dbPath: string;
  /** HTTP/WS port. Default 9876, overridable with `MANAGER_PORT`. */
  readonly httpPort: number;
}

const DEFAULT_PORT = 9876;

export function getConfig(): DaemonConfig {
  const home = process.env.MANAGER_HOME ?? join(homedir(), '.claude', 'manager');
  const portRaw = process.env.MANAGER_PORT;
  const httpPort = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (Number.isNaN(httpPort) || httpPort <= 0) {
    throw new Error(`Invalid MANAGER_PORT: ${portRaw}`);
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
