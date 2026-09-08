import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportSkillToTeamBrain } from '../src/team-brain-skill-export.js';

describe('exportSkillToTeamBrain', () => {
  let teamBrainDir: string;

  beforeEach(async () => {
    teamBrainDir = await mkdtemp(join(tmpdir(), 'team-brain-'));
  });

  afterEach(async () => {
    await rm(teamBrainDir, { recursive: true, force: true });
  });

  it('writes a SKILL.md with a slugified name, description, and the full body', async () => {
    const { path } = await exportSkillToTeamBrain(
      teamBrainDir,
      'Migrate Via Dual-Read',
      'Always dual-read during a schema migration.\n\nMore detail here.',
    );
    expect(path).toBe(join(teamBrainDir, '.agents', 'skills', 'migrate-via-dual-read', 'SKILL.md'));
    const content = await readFile(path, 'utf8');
    expect(content).toContain('name: migrate-via-dual-read');
    expect(content).toContain('description: Always dual-read during a schema migration.');
    expect(content).toContain('# Migrate Via Dual-Read');
    expect(content).toContain('More detail here.');
  });

  it('falls back to a generic description when the body has no non-heading line', async () => {
    const { path } = await exportSkillToTeamBrain(
      teamBrainDir,
      'Headings Only',
      '# Headings Only\n\n## Empty',
    );
    const content = await readFile(path, 'utf8');
    expect(content).toContain(
      'description: Promoted skill distilled from a Dispatch session: Headings Only.',
    );
  });

  it('overwrites an existing SKILL.md for the same slug (idempotent re-promotion)', async () => {
    await exportSkillToTeamBrain(teamBrainDir, 'Same Title', 'first body');
    const { path } = await exportSkillToTeamBrain(teamBrainDir, 'Same Title', 'second body');
    const content = await readFile(path, 'utf8');
    expect(content).toContain('second body');
    expect(content).not.toContain('first body');
  });
});
