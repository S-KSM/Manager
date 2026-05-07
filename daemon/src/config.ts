import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolved daemon configuration. Computed lazily so tests can override
 * `DISPATCH_HOME` / `DISPATCH_PORT` via env before importing other modules.
 */
export interface DaemonConfig {
  /** Root state dir, default `~/.claude/dispatch`. Overridable with `DISPATCH_HOME`. */
  readonly home: string;
  /** Append-only event JSONL files, one per workstream. */
  readonly eventsDir: string;
  /** Markdown memory files, one per workstream. */
  readonly memoryDir: string;
  /** Per-workstream intervention queue files (v0.5+). */
  readonly queuesDir: string;
  /** SQLite registry of workstreams + sessions. */
  readonly dbPath: string;
  /**
   * JSON file holding user-overridable LLM settings (provider, model, ollama
   * URL, anthropic API key). Edited via `PATCH /settings` from the macOS
   * Settings → Providers tab.
   */
  readonly settingsPath: string;
  /** HTTP/WS port. Default 9876, overridable with `DISPATCH_PORT`. */
  readonly httpPort: number;
}

const DEFAULT_PORT = 9876;

export function getConfig(): DaemonConfig {
  const defaultHome = join(homedir(), '.claude', 'dispatch');
  const home = process.env['DISPATCH_HOME'] ?? defaultHome;
  const portRaw = process.env['DISPATCH_PORT'];
  const httpPort = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (Number.isNaN(httpPort) || httpPort <= 0) {
    throw new Error(`Invalid DISPATCH_PORT: ${portRaw}`);
  }

  return {
    home,
    eventsDir: join(home, 'events'),
    memoryDir: join(home, 'memory'),
    queuesDir: join(home, 'queues'),
    dbPath: join(home, 'db.sqlite'),
    settingsPath: join(home, 'settings.json'),
    httpPort,
  };
}
