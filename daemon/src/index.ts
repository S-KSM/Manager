#!/usr/bin/env node
import { buildCli } from './cli.js';

const program = buildCli();
program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[dispatch] fatal: ${msg}\n`);
  process.exit(1);
});
