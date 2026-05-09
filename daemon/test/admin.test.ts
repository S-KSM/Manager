import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  findPidOnPort,
  killPid,
  killWithEscalation,
  parseHostPort,
  pullOllamaModel,
  spawnDetached,
} from '../src/admin.js';

describe('admin.parseHostPort', () => {
  it('extracts host + port from a fully-qualified URL with /v1', () => {
    expect(parseHostPort('http://localhost:8080/v1')).toEqual({
      host: 'localhost',
      port: 8080,
    });
  });

  it('extracts host + port from a URL without /v1', () => {
    expect(parseHostPort('http://localhost:11434')).toEqual({
      host: 'localhost',
      port: 11434,
    });
  });

  it('defaults to port 80 when http and the port is omitted', () => {
    expect(parseHostPort('http://example.com')).toEqual({
      host: 'example.com',
      port: 80,
    });
  });

  it('defaults to port 443 when https and the port is omitted', () => {
    expect(parseHostPort('https://example.com/v1')).toEqual({
      host: 'example.com',
      port: 443,
    });
  });

  it('returns null on a malformed URL', () => {
    expect(parseHostPort('not a url')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseHostPort('')).toBeNull();
  });

  it('handles 127.0.0.1 host', () => {
    expect(parseHostPort('http://127.0.0.1:9876')).toEqual({
      host: '127.0.0.1',
      port: 9876,
    });
  });
});

describe('admin.findPidOnPort', () => {
  it('parses multiple PIDs out of lsof terse output', async () => {
    const execImpl = vi.fn(async () => ({ stdout: '12345\n67890\n', stderr: '' }));
    const pids = await findPidOnPort(8080, { execImpl });
    expect(pids).toEqual([12345, 67890]);
    expect(execImpl).toHaveBeenCalledWith('lsof -i tcp:8080 -sTCP:LISTEN -t');
  });

  it('returns [] when nothing is listening', async () => {
    const execImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    expect(await findPidOnPort(8080, { execImpl })).toEqual([]);
  });

  it('filters out non-numeric stdout lines (lsof warnings)', async () => {
    const execImpl = vi.fn(async () => ({
      stdout: 'lsof: WARNING: ignored line\n12345\n\n',
      stderr: '',
    }));
    expect(await findPidOnPort(8080, { execImpl })).toEqual([12345]);
  });

  it('rejects invalid ports', async () => {
    const execImpl = vi.fn(async () => ({ stdout: '12345\n', stderr: '' }));
    expect(await findPidOnPort(0, { execImpl })).toEqual([]);
    expect(execImpl).not.toHaveBeenCalled();
  });
});

describe('admin.killWithEscalation', () => {
  it('returns escalated=false when SIGTERM lands and the process dies', async () => {
    const seen: Array<{ pid: number; signal: string | number }> = [];
    const killImpl = (pid: number, signal: string | number): void => {
      seen.push({ pid, signal });
      // After SIGTERM, the next isAlive check (process.kill(pid, 0)) finds
      // it gone — model that by throwing on the 0-signal probe.
      if (signal === 0) {
        throw new Error('ESRCH');
      }
    };
    const result = await killWithEscalation(4242, {
      sleepMs: 0,
      sleepImpl: async () => {},
      killImpl,
    });
    expect(result.escalated).toBe(false);
    expect(result.dead).toBe(true);
    expect(seen.find((s) => s.signal === 'SIGTERM')).toBeDefined();
    expect(seen.find((s) => s.signal === 'SIGKILL')).toBeUndefined();
  });

  it('escalates to SIGKILL when SIGTERM did not stop the process', async () => {
    const seen: Array<string | number> = [];
    let alive = true;
    const killImpl = (_pid: number, signal: string | number): void => {
      seen.push(signal);
      if (signal === 'SIGKILL') alive = false;
      if (signal === 0 && !alive) throw new Error('ESRCH');
      // SIGTERM is "delivered" but the (mocked) process keeps running.
    };
    const result = await killWithEscalation(4242, {
      sleepMs: 0,
      sleepImpl: async () => {},
      killImpl,
    });
    expect(result.escalated).toBe(true);
    expect(result.dead).toBe(true);
    expect(seen).toContain('SIGTERM');
    expect(seen).toContain('SIGKILL');
  });

  it('uses the injected sleep helper for the grace period', async () => {
    const sleeps: number[] = [];
    const killImpl = (_pid: number, signal: string | number): void => {
      if (signal === 0) throw new Error('ESRCH');
    };
    await killWithEscalation(4242, {
      sleepMs: 1234,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      killImpl,
    });
    expect(sleeps).toEqual([1234]);
  });
});

describe('admin.killPid', () => {
  it('returns true when the underlying impl succeeds', () => {
    let called = false;
    const ok = killPid(123, 'SIGTERM', {
      processImpl: () => {
        called = true;
      },
    });
    expect(ok).toBe(true);
    expect(called).toBe(true);
  });

  it('returns false when the underlying impl throws (e.g. ESRCH)', () => {
    const ok = killPid(123, 'SIGTERM', {
      processImpl: () => {
        throw new Error('ESRCH');
      },
    });
    expect(ok).toBe(false);
  });
});

describe('admin.spawnDetached', () => {
  it('returns ok:true with pid when spawn succeeds', async () => {
    const fakeChild = {
      pid: 9999,
      unref: vi.fn(),
    } as unknown as ReturnType<NonNullable<Parameters<typeof spawnDetached>[1]>['spawnImpl']>;
    const result = await spawnDetached('echo hi', {
      spawnImpl: () => fakeChild,
    });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(9999);
  });

  it('returns ok:false when spawn throws', async () => {
    const result = await spawnDetached('echo hi', {
      spawnImpl: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('returns ok:false on empty command without invoking spawn', async () => {
    const spawnImpl = vi.fn();
    const result = await spawnDetached('   ', {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnDetached>[1] extends infer T
        ? T extends { spawnImpl?: infer S }
          ? S
          : never
        : never,
    });
    expect(result.ok).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('admin.pullOllamaModel (v1.4.13)', () => {
  /**
   * Build a fake ChildProcess that emits stdout/stderr chunks then closes
   * with `exitCode`. Lets the test exercise the helper's data-collection +
   * tail-truncation logic without a real `ollama` binary.
   */
  function fakeChild(opts: {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    exitCode?: number | null;
    error?: Error;
  }): unknown {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      for (const c of opts.stdoutChunks ?? []) proc.stdout.emit('data', Buffer.from(c));
      for (const c of opts.stderrChunks ?? []) proc.stderr.emit('data', Buffer.from(c));
      if (opts.error) proc.emit('error', opts.error);
      else proc.emit('close', opts.exitCode ?? 0);
    });
    return proc;
  }

  it('rejects an invalid model name without spawning', async () => {
    const spawnImpl = vi.fn();
    const r = await pullOllamaModel('rm -rf /', {
      spawnImpl: spawnImpl as unknown as Parameters<typeof pullOllamaModel>[1] extends infer T
        ? T extends { spawnImpl?: infer S }
          ? S
          : never
        : never,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid model name');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('captures stdout + returns ok=true on exit 0', async () => {
    const r = await pullOllamaModel('qwen3:8b', {
      spawnImpl: (() =>
        fakeChild({
          stdoutChunks: ['pulling manifest\n', 'pulling layer abc\n', 'success\n'],
          exitCode: 0,
        })) as unknown as Parameters<typeof pullOllamaModel>[1] extends infer T
        ? T extends { spawnImpl?: infer S }
          ? S
          : never
        : never,
    });
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain('success');
  });

  it('returns ok=false with stderr tail when ollama exits non-zero', async () => {
    const r = await pullOllamaModel('qwen3:8b', {
      spawnImpl: (() =>
        fakeChild({
          stderrChunks: ['Error: pull model manifest: file does not exist\n'],
          exitCode: 1,
        })) as unknown as Parameters<typeof pullOllamaModel>[1] extends infer T
        ? T extends { spawnImpl?: infer S }
          ? S
          : never
        : never,
    });
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain('Error: pull model manifest');
  });

  it('surfaces ENOENT spawn error with a "ollama CLI not found" hint', async () => {
    const r = await pullOllamaModel('qwen3:8b', {
      spawnImpl: (() =>
        fakeChild({
          error: Object.assign(new Error('spawn ollama ENOENT'), { code: 'ENOENT' }),
        })) as unknown as Parameters<typeof pullOllamaModel>[1] extends infer T
        ? T extends { spawnImpl?: infer S }
          ? S
          : never
        : never,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ollama CLI not found');
  });
});
