import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../src/event-store.js';
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
  let client: Client;
  let prevEnvWorkstream: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-mcp-'));
    registry = new WorkstreamRegistry(join(dir, 'db.sqlite'));
    eventStore = new EventStore(join(dir, 'events'));
    memoryStore = new MemoryStore(join(dir, 'memory'));
    skillProposalsStore = new SkillProposalsStore(join(dir, 'db.sqlite'));
    prevEnvWorkstream = process.env['MANAGER_WORKSTREAM'];
    process.env['MANAGER_WORKSTREAM'] = 'sk_ws';

    const server = buildMcpServer({ eventStore, memoryStore, registry, skillProposalsStore });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    skillProposalsStore.close();
    registry.close();
    if (prevEnvWorkstream === undefined) {
      delete process.env['MANAGER_WORKSTREAM'];
    } else {
      process.env['MANAGER_WORKSTREAM'] = prevEnvWorkstream;
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
