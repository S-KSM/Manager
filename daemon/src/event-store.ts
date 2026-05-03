import { mkdir, open, stat } from 'node:fs/promises';
import { createReadStream, watch as fsWatch, type FSWatcher } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { getConfig } from './config.js';

/**
 * Event matches the schema in docs/ARCHITECTURE.md ("Event (JSONL line in events store)").
 * `id`, `parent_id`, and `payload` are optional at the type level so different event
 * types can carry different shapes; runtime callers fill them per the table.
 */
export interface ManagerEvent {
  ts: string;
  workstream_id: string;
  session_id?: string;
  type: ManagerEventType;
  id?: string;
  parent_id?: string;
  payload?: Record<string, unknown>;
}

export type ManagerEventType =
  | 'session_start'
  | 'session_end'
  | 'decision'
  | 'subgoal_push'
  | 'subgoal_pop'
  | 'confidence'
  | 'tool_use'
  | 'blocked'
  | 'memory_update'
  | 'intervention_delivered';

export interface ReadResult {
  events: ManagerEvent[];
  /** Byte offset to pass back as `sinceOffset` to read only newer events. */
  nextOffset: number;
}

export interface TailHandle {
  close: () => void;
}

/**
 * Append-only JSONL event store, one file per workstream.
 *
 * - `appendEvent` is atomic w.r.t. concurrent appenders thanks to `fs.appendFile`
 *   on POSIX (atomic for buffers <= PIPE_BUF) and the kernel's O_APPEND semantics.
 *   We add a per-process mutex per workstream as belt-and-suspenders.
 * - `readEvents` reads from byte offset → end, returns parsed events plus the new
 *   end-of-file offset (so callers can pass it back to tail forward).
 * - `tailEvents` watches the file with `fs.watch` and falls back to polling on
 *   platforms where watch is unreliable.
 */
export class EventStore {
  private readonly dir: string;
  private readonly perWorkstreamLock = new Map<string, Promise<void>>();

  constructor(dir?: string) {
    this.dir = dir ?? getConfig().eventsDir;
  }

  /** Path to a workstream's JSONL file. */
  pathFor(workstreamId: string): string {
    return join(this.dir, `${workstreamId}.jsonl`);
  }

  /** Ensure the events directory exists. Idempotent. */
  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Cheap approximation of the timestamp of the most recent event: the events
   * file mtime. Returns null if no events have ever been written. Good enough
   * for the home-view "last activity" projection in v0.
   */
  async lastActivityAt(workstreamId: string): Promise<string | null> {
    try {
      const st = await stat(this.pathFor(workstreamId));
      return st.mtime.toISOString();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Atomically append one event line. Serialized per workstream within this
   * process; cross-process atomicity is provided by O_APPEND + the kernel.
   */
  async appendEvent(workstreamId: string, event: ManagerEvent): Promise<void> {
    await this.ensureDir();
    const line = `${JSON.stringify(event)}\n`;
    const file = this.pathFor(workstreamId);
    const prev = this.perWorkstreamLock.get(workstreamId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const handle = await open(file, 'a');
      try {
        await handle.appendFile(line, { encoding: 'utf8' });
      } finally {
        await handle.close();
      }
    });
    // Keep chain alive but don't wedge map on errors.
    this.perWorkstreamLock.set(
      workstreamId,
      next.catch(() => undefined),
    );
    await next;
  }

  /**
   * Read events starting at `sinceOffset` (default 0).
   * Returns parsed events and the new EOF offset. Lines that fail to parse are
   * skipped silently — never throw on malformed history.
   */
  async readEvents(workstreamId: string, sinceOffset = 0): Promise<ReadResult> {
    const file = this.pathFor(workstreamId);
    let endOffset = sinceOffset;
    try {
      const st = await stat(file);
      endOffset = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], nextOffset: 0 };
      }
      throw err;
    }
    if (endOffset <= sinceOffset) {
      return { events: [], nextOffset: endOffset };
    }
    const events: ManagerEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file, {
        start: sinceOffset,
        end: endOffset - 1,
        encoding: 'utf8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          events.push(JSON.parse(trimmed) as ManagerEvent);
        } catch {
          // skip malformed
        }
      });
      rl.on('close', () => resolve());
      rl.on('error', (e) => reject(e));
      stream.on('error', (e) => reject(e));
    });
    return { events, nextOffset: endOffset };
  }

  /**
   * Tail events appended after `sinceOffset`. Calls `onEvent` for each new event
   * until the returned handle is closed. Uses `fs.watch` plus a polling fallback
   * (some FS drivers, network mounts, etc. don't fire watch reliably).
   */
  tailEvents(
    workstreamId: string,
    sinceOffset: number,
    onEvent: (event: ManagerEvent, offset: number) => void,
  ): TailHandle {
    let offset = sinceOffset;
    let stopped = false;
    let inFlight = false;
    let watcher: FSWatcher | undefined;
    let pollTimer: NodeJS.Timeout | undefined;

    const drain = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const result = await this.readEvents(workstreamId, offset);
        offset = result.nextOffset;
        for (const ev of result.events) {
          if (stopped) break;
          onEvent(ev, offset);
        }
      } catch {
        // swallow — tail must not throw into caller
      } finally {
        inFlight = false;
      }
    };

    // Try fs.watch on the events dir so we get notified even if file doesn't exist yet.
    try {
      watcher = fsWatch(this.dir, (_eventType, filename) => {
        if (!filename) return;
        if (filename === `${workstreamId}.jsonl`) {
          void drain();
        }
      });
      watcher.on('error', () => {
        // fall through to poller
      });
    } catch {
      // ignore — poller covers us
    }
    // Always poll as a backstop (1s).
    pollTimer = setInterval(() => void drain(), 1000);
    // Kick once in case events already accrued.
    void drain();

    return {
      close: () => {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (watcher) watcher.close();
      },
    };
  }
}
