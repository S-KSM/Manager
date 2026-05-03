import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { readEnvWithLegacy } from './config.js';
import type { EventStore, ManagerEvent, ManagerEventType } from './event-store.js';
import type { MemoryStore } from './memory-store.js';
import type { SkillProposalsStore } from './skill-proposals.js';
import type { WorkstreamRegistry } from './workstream.js';

/**
 * Reads the workstream id this MCP session is bound to. v0 supports a single
 * workstream per Claude Code session via the `DISPATCH_WORKSTREAM` env var
 * (legacy `MANAGER_WORKSTREAM` honored for one release); v1 will switch to
 * multiplexed sessions.
 */
function resolveWorkstreamId(): string {
  return readEnvWithLegacy('DISPATCH_WORKSTREAM', 'MANAGER_WORKSTREAM') ?? 'default';
}

function resolveSessionId(): string | undefined {
  return readEnvWithLegacy('DISPATCH_SESSION_ID', 'MANAGER_SESSION_ID');
}

interface BuildOptions {
  eventStore: EventStore;
  memoryStore: MemoryStore;
  registry: WorkstreamRegistry;
  skillProposalsStore: SkillProposalsStore;
}

/**
 * MCP tools listed in docs/ARCHITECTURE.md. Each tool maps to event-store
 * and/or memory-store calls. Stdio transport — Claude Code launches the
 * daemon binary with `start` and pipes MCP traffic over stdio.
 */
const TOOLS: Tool[] = [
  {
    name: 'emit_decision',
    description:
      'Record a structured decision point. The unit the methodology timeline is built from.',
    inputSchema: {
      type: 'object',
      required: ['considered', 'choice', 'rationale', 'confidence'],
      properties: {
        considered: {
          type: 'array',
          items: { type: 'string' },
          description: 'Options the agent considered.',
        },
        choice: { type: 'string', description: 'Option chosen.' },
        rationale: { type: 'string', description: 'Why this option.' },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0..1.',
        },
        parent_id: {
          type: 'string',
          description: 'Optional parent decision id (for branching).',
        },
      },
    },
  },
  {
    name: 'emit_subgoal',
    description: 'Push a sub-goal onto the agent goal stack.',
    inputSchema: {
      type: 'object',
      required: ['goal'],
      properties: {
        goal: { type: 'string' },
        parent_id: { type: 'string' },
      },
    },
  },
  {
    name: 'emit_confidence',
    description: 'Spot-update confidence outside a decision.',
    inputSchema: {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'number', minimum: 0, maximum: 1 },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'flag_blocked',
    description: "Escalate — sets the 'needs you' flag in the UI.",
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'update_memory',
    description: 'Write into the workstream memory MD. Replaces or appends a `## section` block.',
    inputSchema: {
      type: 'object',
      required: ['section', 'content'],
      properties: {
        section: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  {
    name: 'read_memory',
    description: 'Read the workstream memory MD. If `section` is given, returns just that section.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string' },
      },
    },
  },
  {
    name: 'propose_skill',
    description:
      'Propose a skill/pattern that should be promoted to the team handbook for all agents to read.',
    inputSchema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        source_decision_id: { type: 'string' },
      },
    },
  },
];

export function buildMcpServer(opts: BuildOptions): Server {
  const { eventStore, memoryStore, registry, skillProposalsStore } = opts;
  const server = new Server(
    {
      name: 'dispatch-daemon',
      version: '0.0.1',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: argsRaw } = req.params;
    const args = (argsRaw ?? {}) as Record<string, unknown>;
    const workstreamId = resolveWorkstreamId();
    const sessionId = resolveSessionId();
    // Make sure the workstream row exists — agents can call MCP tools before any
    // explicit `dispatch register`. ensure() is idempotent.
    registry.ensure(workstreamId);

    const ts = new Date().toISOString();
    const baseEvent = {
      ts,
      workstream_id: workstreamId,
      session_id: sessionId,
    } as const;

    const append = (type: ManagerEventType, payload: Record<string, unknown>): Promise<void> => {
      const ev: ManagerEvent = {
        ...baseEvent,
        type,
        id: `${type}_${randomUUID().slice(0, 8)}`,
        payload,
      };
      const parent = args['parent_id'];
      if (typeof parent === 'string') {
        ev.parent_id = parent;
      }
      return eventStore.appendEvent(workstreamId, ev);
    };

    switch (name) {
      case 'emit_decision': {
        await append('decision', {
          considered: args['considered'] ?? [],
          choice: args['choice'] ?? '',
          rationale: args['rationale'] ?? '',
          confidence: args['confidence'] ?? null,
        });
        return textResult('decision recorded');
      }
      case 'emit_subgoal': {
        await append('subgoal_push', { goal: args['goal'] ?? '' });
        return textResult('subgoal pushed');
      }
      case 'emit_confidence': {
        await append('confidence', { value: args['value'] ?? null, note: args['note'] ?? null });
        return textResult('confidence recorded');
      }
      case 'flag_blocked': {
        await append('blocked', { reason: args['reason'] ?? '' });
        return textResult('blocked flagged');
      }
      case 'update_memory': {
        const section = String(args['section'] ?? '');
        const content = String(args['content'] ?? '');
        if (!section) {
          return errorResult('section is required');
        }
        await memoryStore.updateSection(workstreamId, section, content);
        await append('memory_update', { section });
        return textResult(`memory section "${section}" updated`);
      }
      case 'read_memory': {
        const section = args['section'];
        if (typeof section === 'string' && section.length > 0) {
          const body = await memoryStore.readSection(workstreamId, section);
          return textResult(body ?? '');
        }
        const md = await memoryStore.read(workstreamId);
        return textResult(md);
      }
      case 'propose_skill': {
        const title = String(args['title'] ?? '');
        const body = String(args['body'] ?? '');
        if (!title) return errorResult('title is required');
        if (!body) return errorResult('body is required');
        const sourceDecisionId =
          typeof args['source_decision_id'] === 'string' && args['source_decision_id'].length > 0
            ? (args['source_decision_id'] as string)
            : undefined;
        const proposeArgs: {
          workstream_id: string;
          title: string;
          body: string;
          source_decision_id?: string;
        } = { workstream_id: workstreamId, title, body };
        if (sourceDecisionId) proposeArgs.source_decision_id = sourceDecisionId;
        const proposal = skillProposalsStore.propose(proposeArgs);
        const eventPayload: Record<string, unknown> = {
          proposal_id: proposal.id,
          title: proposal.title,
        };
        if (sourceDecisionId) eventPayload['source_decision_id'] = sourceDecisionId;
        await append('skill_proposed', eventPayload);
        return textResult(`skill proposed: ${proposal.id}`);
      }
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  });

  return server;
}

function textResult(text: string) {
  return {
    content: [{ type: 'text', text } as const],
  };
}

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: 'text', text } as const],
  };
}

/** Connects the MCP server over stdio. Caller awaits the returned promise. */
export async function startMcpStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
