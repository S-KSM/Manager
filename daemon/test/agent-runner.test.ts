import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agent-runner.js';
import type { Issue } from '../src/trackers/index.js';
import { WorkspaceManager } from '../src/workspaces.js';

function fakeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: '1',
    identifier: 'TEST-1',
    title: 'Test issue',
    description: null,
    priority: 1,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: '2026-05-01T00:00:00Z',
    updated_at: null,
    ...over,
  };
}

describe('AgentRunner', () => {
  let root: string;
  let wsMgr: WorkspaceManager;
  let runner: AgentRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runner-'));
    wsMgr = new WorkspaceManager({ root });
    runner = new AgentRunner(wsMgr);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs a successful "turn" (custom command, exit 0)', async () => {
    const ws = await wsMgr.prepare('TEST-1');
    const result = await runner.runTurn({
      workspacePath: ws.path,
      issue: fakeIssue(),
      attempt: null,
      prompt: 'hi',
      command: 'cat > .prompt_received',
      workstreamId: 'test-1',
      log: () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const received = (await readFile(join(ws.path, '.prompt_received'), 'utf8')).trim();
    expect(received).toBe('hi');
  });

  it('captures non-zero exit as turn_failed with stderr tail', async () => {
    const ws = await wsMgr.prepare('TEST-2');
    const result = await runner.runTurn({
      workspacePath: ws.path,
      issue: fakeIssue({ identifier: 'TEST-2' }),
      attempt: 1,
      prompt: '',
      command: 'echo "bad thing happened" 1>&2; exit 3',
      workstreamId: 'test-2',
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toBe('turn_failed');
    expect(result.stderr_tail).toContain('bad thing happened');
  });

  it('enforces turnTimeoutMs and reports turn_timeout', async () => {
    const ws = await wsMgr.prepare('TEST-3');
    const result = await runner.runTurn({
      workspacePath: ws.path,
      issue: fakeIssue({ identifier: 'TEST-3' }),
      attempt: null,
      prompt: '',
      command: 'sleep 5',
      turnTimeoutMs: 200,
      workstreamId: 'test-3',
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('turn_timeout');
  });

  it('sets DISPATCH_WORKSTREAM and DISPATCH_SESSION_ID env vars in the child', async () => {
    const ws = await wsMgr.prepare('TEST-4');
    const result = await runner.runTurn({
      workspacePath: ws.path,
      issue: fakeIssue({ identifier: 'TEST-4' }),
      attempt: null,
      prompt: '',
      command: 'echo "$DISPATCH_WORKSTREAM:$DISPATCH_SESSION_ID" > .env_check',
      workstreamId: 'ws-x',
      log: () => undefined,
    });
    expect(result.ok).toBe(true);
    const env = (await readFile(join(ws.path, '.env_check'), 'utf8')).trim();
    expect(env.startsWith('ws-x:sess_')).toBe(true);
    expect(env).toContain(result.session_id);
  });
});
