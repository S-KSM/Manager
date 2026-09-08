import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agent-runner.js';
import { EventStore } from '../src/event-store.js';
import type { Issue } from '../src/trackers/index.js';
import { WorkspaceManager } from '../src/workspaces.js';

const hasTmux = (() => {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

describe('AgentRunner claude-code-tmux runtime', () => {
  let root: string;
  let wsMgr: WorkspaceManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runner-tmux-'));
    wsMgr = new WorkspaceManager({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fails fast with missing_event_store when constructed without an EventStore', async () => {
    const runner = new AgentRunner(wsMgr); // no EventStore
    const ws = await wsMgr.prepare('TMUX-1');
    const result = await runner.runTurn({
      workspacePath: ws.path,
      issue: fakeIssue({ identifier: 'TMUX-1' }),
      attempt: null,
      prompt: 'hi',
      runtime: 'claude-code-tmux',
      workstreamId: 'tmux-1',
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing_event_store');
  });

  it.skipIf(!hasTmux)(
    'resolves ok:true when a session_end event lands for this run — the Stop-hook completion signal',
    async () => {
      const eventsDir = await mkdtemp(join(tmpdir(), 'agent-runner-tmux-events-'));
      const eventStore = new EventStore(eventsDir);
      const runner = new AgentRunner(wsMgr, eventStore);
      const ws = await wsMgr.prepare('TMUX-2');
      const workstreamId = 'tmux-2';

      let sessionId: string | undefined;
      const resultPromise = runner.runTurn({
        workspacePath: ws.path,
        issue: fakeIssue({ identifier: 'TMUX-2' }),
        attempt: null,
        prompt: 'hi',
        runtime: 'claude-code-tmux',
        // Long-lived stand-in for `claude`: a pane command that exits
        // instantly (e.g. `true`) makes tmux tear the session down before
        // send-keys can act on it, since there's no `remain-on-exit`.
        command: 'sleep 30',
        workstreamId,
        log: (msg, ctx) => {
          if (msg === 'agent_runner.tmux_spawn') sessionId = ctx?.['session_id'] as string;
        },
      });

      // Wait for the tmux pane to actually be created before "delivering" the
      // Stop hook's event — mirrors the real ordering (pane spawns, agent
      // runs, Stop hook fires). Generous bound: under a fully parallel test
      // run, real tmux/bash subprocess spawns compete with every other file.
      for (let i = 0; i < 200 && !sessionId; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(sessionId).toBeDefined();

      await eventStore.appendEvent(workstreamId, {
        ts: new Date().toISOString(),
        workstream_id: workstreamId,
        session_id: sessionId,
        type: 'session_end',
        id: 'evt_test_stop',
      });

      const result = await resultPromise;
      expect(result.ok).toBe(true);
      expect(result.session_id).toBe(sessionId);

      await rm(eventsDir, { recursive: true, force: true });
    },
    30_000,
  );

  it.skipIf(!hasTmux)(
    'reports turn_timeout and kills the tmux session when no session_end arrives',
    async () => {
      const eventsDir = await mkdtemp(join(tmpdir(), 'agent-runner-tmux-events-'));
      const eventStore = new EventStore(eventsDir);
      const runner = new AgentRunner(wsMgr, eventStore);
      const ws = await wsMgr.prepare('TMUX-3');

      let tmuxSession: string | undefined;
      const result = await runner.runTurn({
        workspacePath: ws.path,
        issue: fakeIssue({ identifier: 'TMUX-3' }),
        attempt: null,
        prompt: 'hi',
        runtime: 'claude-code-tmux',
        command: 'sleep 30',
        turnTimeoutMs: 1_000,
        workstreamId: 'tmux-3',
        log: (msg, ctx) => {
          if (msg === 'agent_runner.tmux_spawn') tmuxSession = ctx?.['tmux_session'] as string;
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('turn_timeout');
      expect(tmuxSession).toBeDefined();
      expect(() =>
        execFileSync('tmux', ['has-session', '-t', tmuxSession as string], { stdio: 'ignore' }),
      ).toThrow(); // session was killed on timeout

      await rm(eventsDir, { recursive: true, force: true });
    },
    30_000,
  );
});
