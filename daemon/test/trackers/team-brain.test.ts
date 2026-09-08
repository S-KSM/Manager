import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamBrainTracker } from '../../src/trackers/team-brain.js';
import { TrackerError } from '../../src/trackers/index.js';

async function writePlan(
  plansRoot: string,
  relPath: string,
  opts: { status: string; title?: string; body?: string },
): Promise<void> {
  const abs = join(plansRoot, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  const front = [
    '---',
    `status: ${opts.status}`,
    'namespace: general',
    'source_dump:',
    'related_pr:',
    '---',
    '',
  ].join('\n');
  const body = `# ${opts.title ?? 'Untitled phase'}\n\n${opts.body ?? '## Objective\n\nDo the thing.\n'}`;
  await writeFile(abs, front + body, 'utf8');
}

describe('TeamBrainTracker', () => {
  let plansRoot: string;
  let tracker: TeamBrainTracker;

  beforeEach(async () => {
    plansRoot = await mkdtemp(join(tmpdir(), 'team-brain-plans-'));
    tracker = new TeamBrainTracker(plansRoot);
    await writePlan(plansRoot, 'proj/feat/phase-1-foundation.md', {
      status: 'ready to ship',
      title: 'Phase 1: Foundation',
    });
    await writePlan(plansRoot, 'proj/feat/phase-2-followup.md', {
      status: 'wip',
      title: 'Phase 2: Followup',
    });
    await writePlan(plansRoot, 'proj/other/phase-1-done.md', {
      status: 'implemented-and-synced',
      title: 'Phase 1: Done thing',
    });
    // Template files aren't real plans and must never surface as candidates.
    await writePlan(plansRoot, '_template/phase-N.md', { status: 'wip', title: 'Phase N' });
  });

  afterEach(async () => {
    await rm(plansRoot, { recursive: true, force: true });
  });

  it('reports kind team-brain', () => {
    expect(tracker.kind).toBe('team-brain');
  });

  it('fetchCandidateIssues finds only plans in the active state, excluding _template', async () => {
    const issues = await tracker.fetchCandidateIssues(['ready to ship']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe('proj/feat/phase-1-foundation');
    expect(issues[0]?.title).toBe('Phase 1: Foundation');
    expect(issues[0]?.state).toBe('ready to ship');
    expect(issues[0]?.description).toContain('Do the thing.');
  });

  it('fetchCandidateIssues is case-insensitive on state matching', async () => {
    const issues = await tracker.fetchCandidateIssues(['Ready To Ship']);
    expect(issues).toHaveLength(1);
  });

  it('fetchIssuesByStates filters across multiple state names', async () => {
    const issues = await tracker.fetchIssuesByStates(['wip', 'implemented-and-synced']);
    const ids = issues.map((i) => i.identifier).sort();
    expect(ids).toEqual(['proj/feat/phase-2-followup', 'proj/other/phase-1-done']);
  });

  it('fetchIssueStatesByIds maps identifiers to their current status', async () => {
    const map = await tracker.fetchIssueStatesByIds([
      'proj/feat/phase-1-foundation',
      'proj/other/phase-1-done',
      'does/not/exist',
    ]);
    expect(map.get('proj/feat/phase-1-foundation')).toBe('ready to ship');
    expect(map.get('proj/other/phase-1-done')).toBe('implemented-and-synced');
    expect(map.has('does/not/exist')).toBe(false);
  });

  it('resolveStateIdByName is the identity function', async () => {
    expect(await tracker.resolveStateIdByName('anything')).toBe('anything');
  });

  it('claimIssue rewrites only the status: line, leaving the rest of the file untouched', async () => {
    const before = await readFile(join(plansRoot, 'proj/feat/phase-1-foundation.md'), 'utf8');
    await tracker.claimIssue('proj/feat/phase-1-foundation', {
      stateName: 'implemented-pending-pr',
    });
    const after = await readFile(join(plansRoot, 'proj/feat/phase-1-foundation.md'), 'utf8');
    expect(after).toContain('status: implemented-pending-pr');
    expect(after.replace('status: implemented-pending-pr', 'status: ready to ship')).toBe(before);

    const issues = await tracker.fetchCandidateIssues(['ready to ship']);
    expect(issues).toHaveLength(0);
    const claimed = await tracker.fetchIssuesByStates(['implemented-pending-pr']);
    expect(claimed).toHaveLength(1);
  });

  it('claimIssue throws team_brain_claim_conflict when the plan is already at the target status', async () => {
    await tracker.claimIssue('proj/feat/phase-1-foundation', {
      stateName: 'implemented-pending-pr',
    });
    await expect(
      tracker.claimIssue('proj/feat/phase-1-foundation', { stateName: 'implemented-pending-pr' }),
    ).rejects.toMatchObject({ code: 'team_brain_claim_conflict' } satisfies Partial<TrackerError>);
  });

  it('claimIssue throws team_brain_claim_conflict for an unknown identifier', async () => {
    await expect(
      tracker.claimIssue('does/not/exist', { stateName: 'implemented-pending-pr' }),
    ).rejects.toThrow(TrackerError);
  });

  it('releaseIssue defaults to reverting a plan back to "ready to ship"', async () => {
    await tracker.claimIssue('proj/feat/phase-1-foundation', {
      stateName: 'implemented-pending-pr',
    });
    await tracker.releaseIssue('proj/feat/phase-1-foundation');
    const issues = await tracker.fetchCandidateIssues(['ready to ship']);
    expect(issues.map((i) => i.identifier)).toContain('proj/feat/phase-1-foundation');
  });
});
