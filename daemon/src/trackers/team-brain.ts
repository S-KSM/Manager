import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  type AssigneeFilter,
  type ClaimOptions,
  type Issue,
  type Tracker,
  TrackerError,
} from './index.js';

/**
 * TeamBrainTracker — treats a team-brain checkout's `plans/<namespace>/<feature>/phase-N.md`
 * files as tickets, filling the same `Tracker` interface Linear/Mock implement.
 *
 * There is no separate ticket-id space: a plan's `Issue.id`/`identifier` is its
 * path relative to the plans root with the `.md` suffix stripped (e.g.
 * `1st10s/mvp/phase-1-foundation`), matching the slug `claude-fleet-brain-tasks`
 * already derives from the same convention.
 *
 * "Claiming" a plan is a frontmatter `status:` rewrite (only that one line is
 * touched — every other line, including comments and blank frontmatter
 * fields, is left byte-for-byte alone) rather than a mutex: two daemons racing
 * the same plan will both attempt the same rewrite, and the loser's read of
 * "current status" right before writing won't match what it expects, so it
 * surfaces as a `team_brain_claim_conflict` collision. This narrows the race
 * window to "read plan, then write" but does not eliminate it — there is no
 * cross-process file lock. Fine for a single daemon; revisit if more than one
 * ever watches the same team-brain checkout.
 *
 * No assignee concept exists here (team-brain plans aren't per-user), so
 * `assigneeFilter` is accepted for interface compatibility but ignored —
 * claim/release already remove/restore a plan from the active-state set,
 * which is all the orchestrator's collision avoidance actually needs.
 */
export class TeamBrainTracker implements Tracker {
  readonly kind = 'team-brain';
  private readonly plansRoot: string;

  constructor(plansRoot: string) {
    this.plansRoot = plansRoot;
  }

  async fetchCandidateIssues(
    activeStates: string[],
    _opts?: { assigneeFilter?: AssigneeFilter },
  ): Promise<Issue[]> {
    const set = new Set(activeStates.map((s) => s.toLowerCase()));
    const all = await this.readAll();
    return all.filter((p) => set.has(p.status.toLowerCase())).map(toIssue);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const set = new Set(stateNames.map((s) => s.toLowerCase()));
    const all = await this.readAll();
    return all.filter((p) => set.has(p.status.toLowerCase())).map(toIssue);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>> {
    const wanted = new Set(issueIds);
    const all = await this.readAll();
    const out = new Map<string, string>();
    for (const p of all) {
      if (wanted.has(p.relId)) out.set(p.relId, p.status);
    }
    return out;
  }

  /** Identity — a plan's frontmatter `status:` value IS the state name. */
  async resolveStateIdByName(name: string): Promise<string | null> {
    return name;
  }

  async claimIssue(issueId: string, opts: ClaimOptions): Promise<void> {
    const targetStatus = opts.stateName ?? opts.stateId ?? 'implemented-pending-pr';
    await this.rewriteStatus(issueId, targetStatus, { rejectIfAlready: true });
  }

  async releaseIssue(issueId: string, opts?: ClaimOptions): Promise<void> {
    const targetStatus = opts?.stateName ?? opts?.stateId ?? 'ready to ship';
    await this.rewriteStatus(issueId, targetStatus, { rejectIfAlready: false });
  }

  private async rewriteStatus(
    issueId: string,
    targetStatus: string,
    opts: { rejectIfAlready: boolean },
  ): Promise<void> {
    const plan = await this.findOne(issueId);
    if (!plan) {
      throw new TrackerError(
        'team_brain_claim_conflict',
        `plan "${issueId}" not found under ${this.plansRoot}`,
      );
    }
    // Re-read immediately before writing to narrow (not eliminate) the
    // read-then-write race against a second daemon on the same checkout.
    const raw = await readFile(plan.absPath, 'utf8');
    const current = readStatus(raw);
    if (current === null) {
      throw new TrackerError(
        'team_brain_claim_conflict',
        `plan "${issueId}" has no status: field in its front matter`,
      );
    }
    if (opts.rejectIfAlready && current.toLowerCase() === targetStatus.toLowerCase()) {
      throw new TrackerError(
        'team_brain_claim_conflict',
        `plan "${issueId}" is already at status "${current}" — likely claimed by a concurrent run`,
      );
    }
    const rewritten = replaceStatus(raw, targetStatus);
    if (rewritten === null) {
      throw new TrackerError(
        'team_brain_claim_conflict',
        `plan "${issueId}" front matter changed shape between read and write`,
      );
    }
    await writeFile(plan.absPath, rewritten, 'utf8');
  }

  private async findOne(issueId: string): Promise<PlanRecord | null> {
    const all = await this.readAll();
    return all.find((p) => p.relId === issueId) ?? null;
  }

  private async readAll(): Promise<PlanRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.plansRoot, { recursive: true });
    } catch (err) {
      throw new TrackerError(
        'mock_source_missing',
        `TeamBrainTracker plans root not readable at ${this.plansRoot}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const out: PlanRecord[] = [];
    for (const rel of entries) {
      if (!rel.endsWith('.md')) continue;
      const parts = rel.split(sep);
      if (parts.includes('_template')) continue;
      const absPath = join(this.plansRoot, rel);
      let raw: string;
      try {
        raw = await readFile(absPath, 'utf8');
      } catch {
        continue; // vanished between listing and read — skip, next poll picks it up
      }
      const status = readStatus(raw);
      if (status === null) continue; // not a lifecycle-managed plan file (e.g. a stray README)
      const relId = rel.slice(0, -'.md'.length).split(sep).join('/');
      const body = raw.replace(FRONT_MATTER_RE, '').trim();
      const titleMatch = body.match(/^#\s+(.+)$/m);
      out.push({
        absPath,
        relId,
        status,
        title: titleMatch?.[1]?.trim() || relId,
        body: body.slice(0, PLAN_BODY_CAP),
      });
    }
    return out;
  }
}

interface PlanRecord {
  absPath: string;
  relId: string;
  status: string;
  title: string;
  body: string;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const STATUS_LINE_RE = /^status:[ \t]*.*$/m;
/** Cap the plan body folded into `Issue.description` — full phase specs can run long. */
const PLAN_BODY_CAP = 8_000;

function readStatus(raw: string): string | null {
  const fm = raw.match(FRONT_MATTER_RE);
  if (!fm) return null;
  const line = fm[1]?.match(STATUS_LINE_RE);
  if (!line) return null;
  return line[0].slice('status:'.length).trim();
}

/** Rewrites only the `status:` line inside the leading front-matter block. */
function replaceStatus(raw: string, targetStatus: string): string | null {
  const fm = raw.match(FRONT_MATTER_RE);
  if (!fm || fm.index === undefined) return null;
  const body = fm[1] ?? '';
  if (!STATUS_LINE_RE.test(body)) return null;
  const newBody = body.replace(STATUS_LINE_RE, `status: ${targetStatus}`);
  const newBlock = fm[0].replace(body, newBody);
  return raw.slice(0, fm.index) + newBlock + raw.slice(fm.index + fm[0].length);
}

function toIssue(p: PlanRecord): Issue {
  return {
    id: p.relId,
    identifier: p.relId,
    title: p.title,
    description: p.body || null,
    priority: null,
    state: p.status,
    branch_name: null,
    // file:// so the macOS tracker chip's "Open plan" can hand it to Finder/editor.
    url: `file://${p.absPath}`,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}
