import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../src/config.js';

describe('getConfig', () => {
  const priorHome = process.env['DISPATCH_HOME'];
  const priorLegacy = process.env['MANAGER_HOME'];
  const priorPort = process.env['DISPATCH_PORT'];
  const priorLegacyPort = process.env['MANAGER_PORT'];

  afterEach(() => {
    if (priorHome === undefined) delete process.env['DISPATCH_HOME'];
    else process.env['DISPATCH_HOME'] = priorHome;
    if (priorLegacy === undefined) delete process.env['MANAGER_HOME'];
    else process.env['MANAGER_HOME'] = priorLegacy;
    if (priorPort === undefined) delete process.env['DISPATCH_PORT'];
    else process.env['DISPATCH_PORT'] = priorPort;
    if (priorLegacyPort === undefined) delete process.env['MANAGER_PORT'];
    else process.env['MANAGER_PORT'] = priorLegacyPort;
  });

  it('MANAGER_HOME alone yields the default home (no legacy fallback)', () => {
    delete process.env['DISPATCH_HOME'];
    process.env['MANAGER_HOME'] = '/tmp/legacy-should-not-be-honored';
    const cfg = getConfig();
    expect(cfg.home).toBe(join(homedir(), '.claude', 'dispatch'));
  });

  it('DISPATCH_HOME wins over the default', () => {
    process.env['DISPATCH_HOME'] = '/tmp/custom-dispatch-home';
    const cfg = getConfig();
    expect(cfg.home).toBe('/tmp/custom-dispatch-home');
  });

  it('MANAGER_PORT alone is ignored', () => {
    delete process.env['DISPATCH_PORT'];
    process.env['MANAGER_PORT'] = '12345';
    const cfg = getConfig();
    expect(cfg.httpPort).toBe(9876);
  });

  it('DISPATCH_PORT is parsed', () => {
    process.env['DISPATCH_PORT'] = '54321';
    const cfg = getConfig();
    expect(cfg.httpPort).toBe(54321);
  });
});
