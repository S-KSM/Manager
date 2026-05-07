import { describe, expect, it, vi } from 'vitest';
import {
  findPidOnPort,
  killPid,
  killWithEscalation,
  parseHostPort,
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
