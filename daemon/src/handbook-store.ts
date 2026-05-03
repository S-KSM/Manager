import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';

export interface SkillSource {
  workstream_id?: string;
  decision_id?: string;
}

const HANDBOOK_FILENAME = 'handbook.md';
const HANDBOOK_HEADER = '# Team handbook\n\n';

/**
 * Single Markdown file owned by the manager (human + macOS app), read by all
 * agents at SessionStart. Section layout is `## <skill title>` blocks; each
 * block ends with an italic "from workstream / decision" footer when source
 * is provided.
 *
 * The class serializes appends with a single per-process lock — there is one
 * file, one writer at a time, no need for the per-key lock pattern from
 * `MemoryStore`. v1 accepts last-writer-wins across processes; v1.1 will
 * add an advisory file lock.
 */
export class HandbookStore {
  private readonly path: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(path?: string) {
    this.path = path ?? join(getConfig().home, HANDBOOK_FILENAME);
  }

  pathForFile(): string {
    return this.path;
  }

  /** Read the raw Markdown body. Returns empty string if the file is absent. */
  async read(): Promise<string> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /**
   * Append a `## <title>` section with the body and an optional source footer.
   * Creates the handbook file (with the H1 header) if it does not yet exist.
   */
  async appendSkill(title: string, body: string, source?: SkillSource): Promise<void> {
    const block = renderSkillBlock(title, body, source);
    const prev = this.writeLock;
    const next = prev.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const existing = await this.read();
      const base = existing.length === 0 ? HANDBOOK_HEADER : existing;
      const separator = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
      const updated = `${base}${separator}${block}`;
      await writeFile(this.path, updated, 'utf8');
    });
    this.writeLock = next.catch(() => undefined);
    await next;
  }
}

function renderSkillBlock(title: string, body: string, source?: SkillSource): string {
  const trimmedBody = body.replace(/\s+$/g, '');
  const footer = renderFooter(source);
  if (footer) {
    return `## ${title}\n\n${trimmedBody}\n\n${footer}\n`;
  }
  return `## ${title}\n\n${trimmedBody}\n`;
}

function renderFooter(source?: SkillSource): string | null {
  if (!source) return null;
  const parts: string[] = [];
  if (source.workstream_id) parts.push(`workstream ${source.workstream_id}`);
  if (source.decision_id) parts.push(`decision ${source.decision_id}`);
  if (parts.length === 0) return null;
  return `_(from ${parts.join(' / ')})_`;
}
