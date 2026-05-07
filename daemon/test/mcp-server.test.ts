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
