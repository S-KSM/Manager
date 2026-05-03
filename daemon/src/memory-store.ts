import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from './config.js';

/**
 * Markdown memory file per workstream. Section-aware updates by H2 heading.
 *
 * Layout (per docs/ARCHITECTURE.md):
 *
 * ```
 * # Workstream: <id>
 *
 * ## Goal
 * ...
 *
 * ## Current state
 * ...
 * ```
 *
 * `updateSection(id, name, content)`:
 * - if a section `## name` exists, replaces its body with `content`.
 * - else, appends a new `## name\n\n<content>\n` block at the end.
 * - if the file doesn't exist, creates it with an H1 title and the section.
 */
export class MemoryStore {
  private readonly dir: string;
  private readonly perWorkstreamLock = new Map<string, Promise<void>>();

  constructor(dir?: string) {
    this.dir = dir ?? getConfig().memoryDir;
  }

  pathFor(workstreamId: string): string {
    return join(this.dir, `${workstreamId}.md`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Read full memory file. Returns empty string if absent. */
  async read(workstreamId: string): Promise<string> {
    try {
      return await readFile(this.pathFor(workstreamId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /**
   * Read a single section by H2 name. Returns the body (text under the heading,
   * up to the next H2 or EOF), trimmed. Returns null if not present.
   */
  async readSection(workstreamId: string, sectionName: string): Promise<string | null> {
    const md = await this.read(workstreamId);
    if (!md) return null;
    const sections = parseSections(md);
    const found = sections.find((s) => s.name.toLowerCase() === sectionName.toLowerCase());
    return found ? found.body.trim() : null;
  }

  /**
   * Replace or append the body under `## sectionName`. Serializes per-workstream
   * to make read-modify-write safe under concurrent calls.
   */
  async updateSection(workstreamId: string, sectionName: string, content: string): Promise<void> {
    const prev = this.perWorkstreamLock.get(workstreamId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await this.ensureDir();
      const path = this.pathFor(workstreamId);
      const existing = await this.read(workstreamId);
      const updated = upsertSection(existing, workstreamId, sectionName, content);
      await writeFile(path, updated, 'utf8');
    });
    this.perWorkstreamLock.set(
      workstreamId,
      next.catch(() => undefined),
    );
    await next;
  }
}

interface ParsedSection {
  name: string;
  body: string;
}

/** Splits a markdown doc into H2-rooted sections. Anything before the first H2 is the preamble. */
function parseSections(md: string): ParsedSection[] {
  const lines = md.split('\n');
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { name: m[1] ?? '', body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Upsert a `## sectionName` block in `existing`. If file is empty, generates a
 * full skeleton. Preserves preamble (everything before first H2) and any other
 * sections in their original order.
 */
function upsertSection(
  existing: string,
  workstreamId: string,
  sectionName: string,
  content: string,
): string {
  const trimmedContent = content.replace(/\s+$/g, '');
  if (!existing.trim()) {
    return `# Workstream: ${workstreamId}\n\n## ${sectionName}\n\n${trimmedContent}\n`;
  }
  const firstH2Idx = existing.indexOf('\n## ');
  let preamble: string;
  let rest: string;
  if (firstH2Idx === -1) {
    // No sections yet. Treat whole file as preamble.
    preamble = existing.endsWith('\n') ? existing : `${existing}\n`;
    rest = '';
  } else {
    preamble = existing.slice(0, firstH2Idx + 1); // include trailing newline
    rest = existing.slice(firstH2Idx + 1);
  }
  const sections = parseSections(rest);
  const idx = sections.findIndex((s) => s.name.toLowerCase() === sectionName.toLowerCase());
  if (idx >= 0) {
    sections[idx] = { name: sections[idx]!.name, body: `\n${trimmedContent}\n` };
  } else {
    sections.push({ name: sectionName, body: `\n${trimmedContent}\n` });
  }
  const rebuilt = sections.map((s) => `## ${s.name}\n${s.body}`).join('\n');
  // ensure exactly one blank line between preamble and first section
  const normalizedPreamble = preamble.endsWith('\n\n')
    ? preamble
    : `${preamble.replace(/\n+$/, '')}\n\n`;
  let out = `${normalizedPreamble}${rebuilt}`;
  if (!out.endsWith('\n')) out += '\n';
  return out;
}
