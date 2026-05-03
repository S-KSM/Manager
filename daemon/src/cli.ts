import { mkdir } from 'node:fs/promises';
import { Command } from 'commander';
import { getConfig } from './config.js';
import { EventStore } from './event-store.js';
import { buildHttpServer } from './http-server.js';
import { InterventionQueue } from './intervention-queue.js';
import { buildMcpServer, startMcpStdio } from './mcp-server.js';
import { MemoryStore } from './memory-store.js';
import { WorkstreamRegistry } from './workstream.js';

/**
 * Whether to launch an MCP stdio server in `manager start`.
 * Off by default so a daemon launched as a long-running background process
 * doesn't try to read from a non-existent stdin (which would EOF immediately).
 * Claude Code launches the daemon with this flag set so the MCP transport binds
 * to its stdin/stdout pipe.
 */
const MCP_STDIO_FLAG = '--mcp-stdio';

export function buildCli(): Command {
  const program = new Command();
  program
    .name('manager')
    .description('Manager daemon — local brain for supervising AI agents.')
    .version('0.0.1');

  program
    .command('start')
    .description('Boot HTTP/WS API. Optionally also bind an MCP server to stdio.')
    .option(MCP_STDIO_FLAG, 'Bind the MCP server to stdio (for Claude Code).')
    .action(async (opts: { mcpStdio?: boolean }) => {
      await runStart({ mcpStdio: !!opts.mcpStdio });
    });

  program
    .command('register <id> <title>')
    .description('Create a workstream.')
    .action((id: string, title: string) => {
      const cfg = getConfig();
      const registry = new WorkstreamRegistry(cfg.dbPath);
      try {
        const existing = registry.get(id);
        if (existing) {
          process.stdout.write(`workstream "${id}" already exists\n`);
          return;
        }
        const ws = registry.create(id, title);
        process.stdout.write(
          `registered ${ws.id} — ${ws.title} (status=${ws.status}, created_at=${ws.createdAt})\n`,
        );
      } finally {
        registry.close();
      }
    });

  program
    .command('list')
    .description('List workstreams.')
    .action(() => {
      const cfg = getConfig();
      const registry = new WorkstreamRegistry(cfg.dbPath);
      try {
        const all = registry.list();
        if (all.length === 0) {
          process.stdout.write('(no workstreams)\n');
          return;
        }
        const idW = Math.max(2, ...all.map((w) => w.id.length));
        const titleW = Math.max(5, ...all.map((w) => w.title.length));
        const statusW = Math.max(6, ...all.map((w) => w.status.length));
        const header = `${pad('ID', idW)}  ${pad('TITLE', titleW)}  ${pad('STATUS', statusW)}  CREATED`;
        process.stdout.write(`${header}\n`);
        process.stdout.write(`${'-'.repeat(header.length)}\n`);
        for (const w of all) {
          process.stdout.write(
            `${pad(w.id, idW)}  ${pad(w.title, titleW)}  ${pad(w.status, statusW)}  ${w.createdAt}\n`,
          );
        }
      } finally {
        registry.close();
      }
    });

  program
    .command('attach <workstream-id>')
    .description('Print env vars and instructions for hooking a Claude Code session.')
    .action((workstreamId: string) => {
      const cfg = getConfig();
      const sessionId = `sess-${Date.now().toString(36)}`;
      process.stdout.write(
        [
          '# Add these to your shell before launching Claude Code:',
          `export MANAGER_WORKSTREAM=${shellQuote(workstreamId)}`,
          `export MANAGER_SESSION_ID=${shellQuote(sessionId)}`,
          `export MANAGER_PORT=${cfg.httpPort}`,
          '',
          '# Then install the lifecycle hooks:',
          '#   bash hooks/install.sh',
          '',
          '# The MCP server can be added to ~/.claude/settings.json under',
          '# "mcpServers" with command="node" args=["<this-repo>/daemon/dist/index.js","start","--mcp-stdio"].',
        ].join('\n'),
      );
      process.stdout.write('\n');
    });

  return program;
}

async function runStart(opts: { mcpStdio: boolean }): Promise<void> {
  const cfg = getConfig();
  await Promise.all([
    mkdir(cfg.eventsDir, { recursive: true }),
    mkdir(cfg.memoryDir, { recursive: true }),
    mkdir(cfg.queuesDir, { recursive: true }),
  ]);
  const registry = new WorkstreamRegistry(cfg.dbPath);
  const eventStore = new EventStore(cfg.eventsDir);
  const memoryStore = new MemoryStore(cfg.memoryDir);
  const interventionQueue = new InterventionQueue(cfg.dbPath);
  const http = buildHttpServer({ eventStore, memoryStore, registry, interventionQueue });
  const port = await http.listen(cfg.httpPort);
  // stderr so JSON-over-stdout MCP traffic stays clean.
  process.stderr.write(`[manager] HTTP/WS listening on http://127.0.0.1:${port}\n`);
  process.stderr.write(`[manager] state at ${cfg.home}\n`);

  let mcpRunning = false;
  if (opts.mcpStdio) {
    const mcp = buildMcpServer({ eventStore, memoryStore, registry });
    await startMcpStdio(mcp);
    mcpRunning = true;
    process.stderr.write('[manager] MCP server bound to stdio\n');
  }

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[manager] shutting down\n');
    try {
      await http.close();
      registry.close();
      interventionQueue.close();
    } catch (e) {
      process.stderr.write(`[manager] shutdown error: ${(e as Error).message}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // If MCP isn't bound, keep alive via SIGINT/SIGTERM only. If MCP is bound,
  // the stdio transport keeps the loop alive on its own.
  if (!mcpRunning) {
    // Express/HTTP server keeps the loop alive; nothing more to do.
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
