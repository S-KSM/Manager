import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../src/event-store.js';
import { InterventionQueue } from '../src/intervention-queue.js';
import { buildMcpServer } from '../src/mcp-server.js';
import { MemoryStore } from '../src/memory-store.js';
import { SkillProposalsStore } from '../src/skill-proposals.js';
import { WorkstreamRegistry } from '../src/workstream.js';

describe('MCP server propose_skill tool', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let skillProposalsStore: SkillProposalsStore;
  let interventionQueue: InterventionQueue;
  let client: Client;
  let prevEnvWorkstream: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-mcp-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    prevEnvWorkstream = process.env['DISPATCH_WORKSTREAM'];
    process.env['DISPATCH_WORKSTREAM'] = 'sk_ws';

    const server = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    skillProposalsStore.close();
    interventionQueue.close();
    registry.close();
    if (prevEnvWorkstream === undefined) {
      delete process.env['DISPATCH_WORKSTREAM'];
    } else {
      process.env['DISPATCH_WORKSTREAM'] = prevEnvWorkstream;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists propose_skill in tools/list', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('propose_skill');
  });

  it('propose_skill persists into SQLite + appends a skill_proposed event to the JSONL log', async () => {
    const result = await client.callTool({
      name: 'propose_skill',
      arguments: {
        title: 'Migrate via dual-read',
        body: 'do X then Y',
        source_decision_id: 'dec_07',
      },
    });
    expect(result.isError).not.toBe(true);

    const proposals = skillProposalsStore.listProposed();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.workstream_id).toBe('sk_ws');
    expect(proposals[0]!.title).toBe('Migrate via dual-read');
    expect(proposals[0]!.body).toBe('do X then Y');
    expect(proposals[0]!.source_decision_id).toBe('dec_07');

    const { events } = await eventStore.readEvents('sk_ws');
    const proposed = events.filter((e) => e.type === 'skill_proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.payload?.['proposal_id']).toBe(proposals[0]!.id);
    expect(proposed[0]!.payload?.['title']).toBe('Migrate via dual-read');
  });

  it('propose_skill returns an error when title or body is empty', async () => {
    const result = await client.callTool({
      name: 'propose_skill',
      arguments: { title: '', body: 'something' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('MCP server transition_ticket tool (v1.4.17)', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let skillProposalsStore: SkillProposalsStore;
  let interventionQueue: InterventionQueue;
  let client: Client;
  let prevEnvWorkstream: string | undefined;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-transition-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    prevEnvWorkstream = process.env['DISPATCH_WORKSTREAM'];
    process.env['DISPATCH_WORKSTREAM'] = 'tx_ws';
    fetchCalls = [];
    const fakeFetch: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      fetchCalls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({ ok: true, workstream_id: 'tx_ws', issue_id: 'i_1', state: 'Done' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const server = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
      daemonUrl: 'http://test-daemon:9999',
      fetchImpl: fakeFetch,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([client.connect(ct), server.connect(st)]);
  });
  afterEach(async () => {
    await client.close();
    skillProposalsStore.close();
    interventionQueue.close();
    registry.close();
    if (prevEnvWorkstream === undefined) {
      delete process.env['DISPATCH_WORKSTREAM'];
    } else {
      process.env['DISPATCH_WORKSTREAM'] = prevEnvWorkstream;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists transition_ticket in tools/list', async () => {
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toContain('transition_ticket');
  });

  it('POSTs to /trackers/transition with workstream_id + state + comment, mirrors decision', async () => {
    const r = await client.callTool({
      name: 'transition_ticket',
      arguments: { state: 'Done', comment: 'Shipped via PR #42' },
    });
    expect(r.isError).not.toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('http://test-daemon:9999/trackers/transition');
    expect(fetchCalls[0]!.body).toEqual({
      workstream_id: 'tx_ws',
      state: 'Done',
      comment: 'Shipped via PR #42',
    });
    const { events } = await eventStore.readEvents('tx_ws');
    const decisions = events.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload?.['choice']).toBe('transition_ticket');
    expect(decisions[0]!.payload?.['rationale']).toContain('Done');
  });

  it('returns an error result when state is missing', async () => {
    const r = await client.callTool({ name: 'transition_ticket', arguments: {} });
    expect(r.isError).toBe(true);
  });
});

describe('MCP server open_pr tool (v1.4.17)', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let skillProposalsStore: SkillProposalsStore;
  let interventionQueue: InterventionQueue;
  let prevEnvWorkstream: string | undefined;

  /**
   * Build a fake ChildProcess that emits stdout chunks then closes with
   * `exitCode`. Used to simulate git / gh in the open_pr path.
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

  function buildClient(spawnSeq: Array<(cmd: string, args: readonly string[]) => unknown>): {
    client: Client;
    server: ReturnType<typeof buildMcpServer>;
  } {
    let i = 0;
    const spawnImpl = ((cmd: string, args: readonly string[]) => {
      const handler = spawnSeq[i++];
      if (!handler) throw new Error(`unexpected spawn ${i}: ${cmd} ${args.join(' ')}`);
      return handler(cmd, args);
    }) as unknown as Parameters<typeof buildMcpServer>[0]['openPrSpawnImpl'];
    const server = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
      ...(spawnImpl ? { openPrSpawnImpl: spawnImpl } : {}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
    void Promise.all([client.connect(ct), server.connect(st)]);
    return { client, server };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-open-pr-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    prevEnvWorkstream = process.env['DISPATCH_WORKSTREAM'];
    process.env['DISPATCH_WORKSTREAM'] = 'pr_ws';
  });
  afterEach(() => {
    skillProposalsStore.close();
    interventionQueue.close();
    registry.close();
    if (prevEnvWorkstream === undefined) {
      delete process.env['DISPATCH_WORKSTREAM'];
    } else {
      process.env['DISPATCH_WORKSTREAM'] = prevEnvWorkstream;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to open a PR from main branch', async () => {
    const { client } = buildClient([() => fakeChild({ stdoutChunks: ['main\n'], exitCode: 0 })]);
    try {
      const r = await client.callTool({
        name: 'open_pr',
        arguments: { title: 't', body: 'b' },
      });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('protected branch');
    } finally {
      await client.close();
    }
  });

  it('refuses on a dirty working tree', async () => {
    const { client } = buildClient([
      () => fakeChild({ stdoutChunks: ['feature/foo\n'], exitCode: 0 }),
      () => fakeChild({ stdoutChunks: [' M src/foo.ts\n'], exitCode: 0 }),
    ]);
    try {
      const r = await client.callTool({
        name: 'open_pr',
        arguments: { title: 't', body: 'b' },
      });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('uncommitted changes');
    } finally {
      await client.close();
    }
  });

  it('happy path: branch ok, clean tree, push ok, gh prints url', async () => {
    const { client } = buildClient([
      () => fakeChild({ stdoutChunks: ['feature/foo\n'], exitCode: 0 }),
      () => fakeChild({ stdoutChunks: [''], exitCode: 0 }),
      () => fakeChild({ stdoutChunks: ['Branch pushed.\n'], exitCode: 0 }),
      () =>
        fakeChild({
          stdoutChunks: [
            'Creating pull request for feature/foo into main\n',
            'https://github.com/me/repo/pull/42\n',
          ],
          exitCode: 0,
        }),
    ]);
    try {
      const r = await client.callTool({
        name: 'open_pr',
        arguments: { title: 'feat: X', body: 'body' },
      });
      expect(r.isError).not.toBe(true);
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('https://github.com/me/repo/pull/42');
      expect(text).toContain('feature/foo');
      const { events } = await eventStore.readEvents('pr_ws');
      const decisions = events.filter((e) => e.type === 'decision');
      expect(decisions[0]!.payload?.['choice']).toBe('open_pr');
    } finally {
      await client.close();
    }
  });
});

describe('MCP server file_ticket tool (v1.4.11)', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let skillProposalsStore: SkillProposalsStore;
  let interventionQueue: InterventionQueue;
  let client: Client;
  let prevEnvWorkstream: string | undefined;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-file-ticket-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    prevEnvWorkstream = process.env['DISPATCH_WORKSTREAM'];
    process.env['DISPATCH_WORKSTREAM'] = 'tk_ws';
    fetchCalls = [];
    const fakeFetch: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      fetchCalls.push({ url: String(url), body });
      return new Response(JSON.stringify({ id: 'i_1', identifier: 'NEW-1', url: 'https://x/1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const server = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
      daemonUrl: 'http://test-daemon:9999',
      fetchImpl: fakeFetch,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    skillProposalsStore.close();
    interventionQueue.close();
    registry.close();
    if (prevEnvWorkstream === undefined) {
      delete process.env['DISPATCH_WORKSTREAM'];
    } else {
      process.env['DISPATCH_WORKSTREAM'] = prevEnvWorkstream;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists file_ticket in tools/list', async () => {
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toContain('file_ticket');
  });

  it('POSTs to /trackers/issues and mirrors a decision event on success', async () => {
    const result = await client.callTool({
      name: 'file_ticket',
      arguments: { title: 'New thing', description: 'body', priority: 2 },
    });
    expect(result.isError).not.toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('http://test-daemon:9999/trackers/issues');
    expect(fetchCalls[0]!.body).toMatchObject({ title: 'New thing', priority: 2 });
    const { events } = await eventStore.readEvents('tk_ws');
    const decisions = events.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload?.['choice']).toBe('file_ticket');
    expect(decisions[0]!.payload?.['rationale']).toContain('NEW-1');
  });

  it('returns an error when daemon is unreachable', async () => {
    const downFetch: typeof fetch = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const downServer = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
      daemonUrl: 'http://down:9999',
      fetchImpl: downFetch,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([c2.connect(ct), downServer.connect(st)]);
    try {
      const r = await c2.callTool({ name: 'file_ticket', arguments: { title: 'X' } });
      expect(r.isError).toBe(true);
    } finally {
      await c2.close();
    }
  });
});

describe('MCP server ask_user tool', () => {
  let dir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let memoryStore: MemoryStore;
  let skillProposalsStore: SkillProposalsStore;
  let interventionQueue: InterventionQueue;
  let client: Client;
  let prevEnvWorkstream: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-ask-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    interventionQueue = new InterventionQueue(join(dir, 'db.sqlite'));
    prevEnvWorkstream = process.env['DISPATCH_WORKSTREAM'];
    process.env['DISPATCH_WORKSTREAM'] = 'ask_ws';

    const server = buildMcpServer({
      eventStore,
      memoryStore,
      registry,
      skillProposalsStore,
      interventionQueue,
      // Tight poll/timeout knobs so the test runs fast.
      askUserPollMs: 25,
      askUserDefaultTimeoutSec: 1,
      askUserMaxTimeoutSec: 5,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    skillProposalsStore.close();
    interventionQueue.close();
    registry.close();
    if (prevEnvWorkstream === undefined) {
      delete process.env['DISPATCH_WORKSTREAM'];
    } else {
      process.env['DISPATCH_WORKSTREAM'] = prevEnvWorkstream;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists ask_user in tools/list', async () => {
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toContain('ask_user');
  });

  it('returns the manager answer when answerQuestion lands during the poll', async () => {
    // Race the tool call against an out-of-band answer. The MCP server polls
    // SQLite at askUserPollMs cadence; once the manager answers via the
    // queue, the next poll returns the choice to the agent.
    const callPromise = client.callTool({
      name: 'ask_user',
      arguments: {
        question: 'Pick one',
        options: ['a', 'b'],
        timeout_seconds: 2,
      },
    });
    // Wait long enough for the enqueue to happen before answering.
    await new Promise((r) => setTimeout(r, 100));
    const pending = interventionQueue.listPending('ask_ws');
    expect(pending).toHaveLength(1);
    interventionQueue.answerQuestion(pending[0]!.id, { choice: 'b' });
    const result = await callPromise;
    expect(result.isError).not.toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.answered).toBe(true);
    expect(parsed.choice).toBe('b');
  });

  it('returns answered:false on timeout', async () => {
    const result = await client.callTool({
      name: 'ask_user',
      arguments: {
        question: 'No one will answer',
        options: ['x'],
        timeout_seconds: 1,
      },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.answered).toBe(false);
    expect(parsed.reason).toBe('timeout');
  });

  it('errors when neither options nor allow_freetext are supplied', async () => {
    const result = await client.callTool({
      name: 'ask_user',
      arguments: { question: 'lonely', timeout_seconds: 1 },
    });
    expect(result.isError).toBe(true);
  });
});
