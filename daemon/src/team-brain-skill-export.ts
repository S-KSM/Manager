import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Mirrors a promoted skill (see `HandbookStore.appendSkill`, called from the
 * `POST /skills/proposed/:id/promote` route) into a team-brain checkout's
 * `.agents/skills/<slug>/SKILL.md` — the format `/skills-sync` fans out to
 * every repo/surface.
 *
 * The handbook stays the fast path (inlined at every session's `SessionStart`
 * on this machine); this makes the promotion durable and shared across
 * machines/repos instead of local-only. Best-effort by design — a promotion
 * must never fail because team-brain is unset, missing, or unwritable, so
 * callers should catch and log rather than let this reject the HTTP response.
 */
export async function exportSkillToTeamBrain(
  teamBrainDir: string,
  title: string,
  body: string,
): Promise<{ path: string }> {
  const slug = slugify(title);
  const path = join(teamBrainDir, '.agents', 'skills', slug, 'SKILL.md');
  const description = firstLineDescription(body, title);
  const frontMatter = ['---', `name: ${slug}`, `description: ${description}`, '---', ''].join('\n');
  const content = `${frontMatter}\n# ${title}\n\n${body.trim()}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { path };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'promoted-skill';
}

/** A SKILL.md `description:` must be one line; fold whatever the LLM-distilled body opens with into one. */
function firstLineDescription(body: string, title: string): string {
  const firstLine = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  const source = firstLine ?? `Promoted skill distilled from a Dispatch session: ${title}.`;
  const oneLine = source.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}
