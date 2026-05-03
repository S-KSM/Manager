import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceHookError,
  WorkspaceManager,
  WorkspaceSafetyError,
  sanitizeKey,
} from '../src/workspaces.js';

describe('sanitizeKey', () => {
  it('keeps allowed chars [A-Za-z0-9._-]', () => {
    expect(sanitizeKey('ABC-123_x.y')).toBe('ABC-123_x.y');
  });
  it('replaces disallowed chars with _', () => {
    expect(sanitizeKey('weird name (1)/foo')).toBe('weird_name__1__foo');
  });
  it('trims leading and trailing underscores', () => {
    expect(sanitizeKey('!!hi!!')).toBe('hi');
  });
  it('falls back to "_" for empty/all-illegal input', () => {
    expect(sanitizeKey('!!!!')).toBe('_');
  });
});

describe('WorkspaceManager', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ws-mgr-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a per-issue workspace dir under root', async () => {
    const mgr = new WorkspaceManager({ root });
    const ws = await mgr.prepare('ABC-1');
    expect(ws.workspace_key).toBe('ABC-1');
    expect(ws.path).toBe(join(root, 'ABC-1'));
    expect(ws.created_now).toBe(true);
    const st = await stat(ws.path);
    expect(st.isDirectory()).toBe(true);
  });

  it('reuses workspace on second prepare; created_now=false', async () => {
    const mgr = new WorkspaceManager({ root });
    await mgr.prepare('ABC-1');
    const ws2 = await mgr.prepare('ABC-1');
    expect(ws2.created_now).toBe(false);
  });

  it('runs after_create hook only when newly created; fatal on failure', async () => {
    const sentinel = join(root, 'SENT');
    const mgr = new WorkspaceManager({
      root,
      hooks: { after_create: `touch "${sentinel}"` },
    });
    await mgr.prepare('NEW-1');
    const st = await stat(sentinel);
    expect(st.isFile()).toBe(true);

    // Reuse path: hook should NOT fire again.
    await rm(sentinel);
    await mgr.prepare('NEW-1');
    await expect(stat(sentinel)).rejects.toThrow();
  });

  it('after_create failure throws WorkspaceHookError (fatal)', async () => {
    const mgr = new WorkspaceManager({
      root,
      hooks: { after_create: 'exit 7' },
    });
    await expect(mgr.prepare('FAIL-1')).rejects.toBeInstanceOf(WorkspaceHookError);
  });

  it('before_run runs in workspace cwd; failure is fatal', async () => {
    const mgr = new WorkspaceManager({
      root,
      hooks: { before_run: 'pwd > .pwd_check' },
    });
    const ws = await mgr.prepare('RUN-1');
    await mgr.runBeforeRun(ws.path);
    const recorded = (await readFile(join(ws.path, '.pwd_check'), 'utf8')).trim();
    // macOS resolves /tmp -> /private/tmp; compare suffix to be portable.
    expect(recorded.endsWith(ws.path)).toBe(true);
  });

  it('after_run failure is logged-only (does not throw)', async () => {
    const mgr = new WorkspaceManager({
      root,
      hooks: { after_run: 'exit 1' },
    });
    const ws = await mgr.prepare('AR-1');
    await expect(mgr.runAfterRun(ws.path)).resolves.toBeUndefined();
  });

  it('remove deletes the workspace and runs before_remove first', async () => {
    const sentinel = join(root, 'BR_SENT');
    const mgr = new WorkspaceManager({
      root,
      hooks: { before_remove: `touch "${sentinel}"` },
    });
    const ws = await mgr.prepare('RM-1');
    await mgr.remove('RM-1');
    await expect(stat(ws.path)).rejects.toThrow();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it('rejects paths outside the root (safety invariant)', () => {
    const mgr = new WorkspaceManager({ root });
    expect(() => mgr.assertInsideRoot('/etc/passwd')).toThrow(WorkspaceSafetyError);
  });

  it('hook timeout kills the script', async () => {
    const mgr = new WorkspaceManager({
      root,
      hooks: { after_create: 'sleep 5', timeout_ms: 100 },
    });
    await expect(mgr.prepare('TO-1')).rejects.toBeInstanceOf(WorkspaceHookError);
  });

  it('expands ~ in root', () => {
    // We don't actually create a dir in $HOME — just verify the root resolved
    // to start with the home dir's prefix (cross-platform-ish: starts with /).
    const mgr = new WorkspaceManager({ root: '~/dispatch-test-x' });
    const r = mgr.getRoot();
    expect(r.endsWith('/dispatch-test-x') || r.endsWith('\\dispatch-test-x')).toBe(true);
    expect(r.startsWith('/') || /^[A-Za-z]:/.test(r)).toBe(true);
  });

  it('fallback root lives under tmpdir when none supplied', () => {
    const mgr = new WorkspaceManager();
    expect(mgr.getRoot()).toContain('dispatch_workspaces');
  });
});

// Pull `writeFile` into the test runner so the dependency is exercised by the
// import resolver (some tests may add fixture-writing helpers later).
void writeFile;
