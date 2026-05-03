import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Cron } from 'croner';
import { getConfig } from './config.js';
import { type LLMProviderName, getProvider } from './llm/index.js';
import { assembleReport } from './report-engine.js';
import { renderUserPrompt } from './report-prompt.js';
import { getPreset } from './report-presets.js';
import type { ReportStore } from './report-store.js';
import type { EventStore } from './event-store.js';
import type { MemoryStore } from './memory-store.js';
import type { WorkstreamRegistry } from './workstream.js';

/**
 * Wire shape for `GET /scheduler/jobs`. Each job describes a recurring report
 * generation; `next_fire_at` is computed from the cron expression and reflects
 * the next future tick (missed ticks are not backfilled — see runJob).
 */
export interface SchedulerJob {
  id: string;
  enabled: boolean;
  cron: string;
  audience_preset: string;
  provider: LLMProviderName;
  model: string | null;
  next_fire_at: string | null;
}

export interface SchedulerJobUpdate {
  enabled?: boolean;
  cron?: string;
  audience_preset?: string;
  provider?: LLMProviderName;
  model?: string | null;
}

export interface SchedulerDeps {
  registry: WorkstreamRegistry;
  eventStore: EventStore;
  memoryStore: MemoryStore;
  reportStore: ReportStore;
}

interface PersistedJob {
  enabled: boolean;
  cron: string;
  audience_preset: string;
  provider: LLMProviderName;
  model?: string | null;
}

interface PersistedConfig {
  [jobId: string]: PersistedJob;
}

const DEFAULT_CONFIG: PersistedConfig = {
  weekly_report: {
    enabled: false,
    cron: '0 8 * * 1',
    audience_preset: 'executive',
    provider: 'claude',
  },
  monthly_report: {
    enabled: false,
    cron: '0 8 1 * *',
    audience_preset: 'executive',
    provider: 'claude',
  },
};

const TICK_INTERVAL_MS = 60_000;

interface JobRuntime {
  config: PersistedJob;
  nextFireMs: number | null;
}

/**
 * In-process cron-like scheduler that triggers report generation on the
 * configured cadence. Persists per-job config to `~/.claude/dispatch/scheduler.json`
 * so toggles survive daemon restarts. Uses `croner` to parse cron expressions
 * and compute next fire times.
 *
 * Missed-tick policy: on boot, each enabled job's next fire is the next
 * future tick (no backfill of fires the daemon was offline for). This
 * trades completeness for predictable behaviour and avoids stomping the LLM
 * with N back-to-back generations after a long downtime.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly path: string;
  private jobs: Map<string, JobRuntime> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(deps: SchedulerDeps, configPath?: string) {
    this.deps = deps;
    this.path = configPath ?? join(getConfig().home, 'scheduler.json');
  }

  /** Load persisted config and arm next-fire times. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    const cfg = await this.readConfig();
    for (const [id, jobCfg] of Object.entries(cfg)) {
      this.jobs.set(id, {
        config: jobCfg,
        nextFireMs: jobCfg.enabled ? computeNextFireMs(jobCfg.cron) : null,
      });
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.started = true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  listJobs(): SchedulerJob[] {
    const out: SchedulerJob[] = [];
    for (const [id, rt] of this.jobs.entries()) {
      out.push(toWire(id, rt));
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  getJob(id: string): SchedulerJob | null {
    const rt = this.jobs.get(id);
    return rt ? toWire(id, rt) : null;
  }

  /**
   * Apply a partial update, persist, and reschedule the next fire time.
   * Throws on unknown job id or invalid cron expression.
   */
  async updateJob(id: string, fields: SchedulerJobUpdate): Promise<SchedulerJob> {
    const rt = this.jobs.get(id);
    if (!rt) throw new Error(`unknown scheduler job: ${id}`);
    const next: PersistedJob = { ...rt.config };
    if (fields.enabled !== undefined) next.enabled = !!fields.enabled;
    if (fields.cron !== undefined) {
      // Validate cron eagerly so invalid input fails the PATCH, not the next tick.
      computeNextFireMs(fields.cron);
      next.cron = fields.cron;
    }
    if (fields.audience_preset !== undefined) next.audience_preset = fields.audience_preset;
    if (fields.provider !== undefined) next.provider = fields.provider;
    if (fields.model !== undefined) next.model = fields.model;

    const updated: JobRuntime = {
      config: next,
      nextFireMs: next.enabled ? computeNextFireMs(next.cron) : null,
    };
    this.jobs.set(id, updated);
    await this.writeConfig();
    return toWire(id, updated);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, rt] of this.jobs.entries()) {
      if (!rt.config.enabled) continue;
      if (rt.nextFireMs === null) continue;
      if (now < rt.nextFireMs) continue;
      try {
        await this.runJob(id, rt.config);
      } catch (err) {
        // Never let a failing job kill the scheduler; surface to stderr.
        process.stderr.write(
          `[scheduler] job ${id} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      // Advance to the next future fire — explicitly do NOT backfill.
      rt.nextFireMs = computeNextFireMs(rt.config.cron, now + 1);
    }
  }

  /**
   * Generate a draft report for all currently-active workstreams and persist
   * it. Picks audience preset / provider / model from the job config; falls
   * back to a generic "Update" title if the period label can't be derived.
   */
  private async runJob(id: string, job: PersistedJob): Promise<void> {
    const since = computeSinceForJob(id);
    const until = new Date();
    const activeIds = this.deps.registry
      .list()
      .filter((w) => w.status === 'active')
      .map((w) => w.id);
    if (activeIds.length === 0) return; // nothing to summarise

    const ctx = await assembleReport(this.deps, {
      workstream_ids: activeIds,
      since,
      until,
    });
    const preset = getPreset(job.audience_preset);
    const systemPrompt = preset?.system_prompt ?? 'You write a concise team update. Be specific.';
    const periodLabel = jobIdToPeriodLabel(id);
    const audienceLabel = preset?.name ?? 'team';
    const userPrompt = renderUserPrompt({
      ctx,
      audience_label: audienceLabel,
      period_label: periodLabel,
    });
    const provider = getProvider(job.provider);
    const body = await provider.generate({
      system: systemPrompt,
      user: userPrompt,
      ...(job.model ? { model: job.model } : {}),
    });
    const title = `${periodLabel} — ${until.toISOString().slice(0, 10)}`;
    this.deps.reportStore.create({
      title,
      audience_preset: job.audience_preset,
      audience_freetext: null,
      period_since: since.toISOString(),
      period_until: until.toISOString(),
      workstream_ids: activeIds,
      provider: job.provider,
      model: job.model ?? null,
      body_md: body,
      status: 'draft',
    });
  }

  private async readConfig(): Promise<PersistedConfig> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const merged: PersistedConfig = { ...DEFAULT_CONFIG };
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v && typeof v === 'object') {
            const obj = v as Partial<PersistedJob>;
            const base = DEFAULT_CONFIG[k] ?? {
              enabled: false,
              cron: '0 8 * * 1',
              audience_preset: 'executive',
              provider: 'claude' as LLMProviderName,
            };
            merged[k] = {
              enabled: typeof obj.enabled === 'boolean' ? obj.enabled : base.enabled,
              cron: typeof obj.cron === 'string' ? obj.cron : base.cron,
              audience_preset:
                typeof obj.audience_preset === 'string'
                  ? obj.audience_preset
                  : base.audience_preset,
              provider:
                obj.provider === 'claude' || obj.provider === 'ollama'
                  ? obj.provider
                  : base.provider,
              ...(obj.model !== undefined ? { model: obj.model } : {}),
            };
          }
        }
        return merged;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        process.stderr.write(
          `[scheduler] failed to read ${this.path}: ${(err as Error).message}\n`,
        );
      }
    }
    // First boot: seed defaults to disk so the macOS app sees them.
    await this.writeFromConfig(DEFAULT_CONFIG);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PersistedConfig;
  }

  private async writeConfig(): Promise<void> {
    const out: PersistedConfig = {};
    for (const [id, rt] of this.jobs.entries()) {
      out[id] = rt.config;
    }
    await this.writeFromConfig(out);
  }

  private async writeFromConfig(cfg: PersistedConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  }
}

/**
 * Parse a cron expression and return the next fire time (ms epoch) at or
 * after `from`. Throws on invalid input. Exported only for tests.
 */
export function computeNextFireMs(cron: string, from: number = Date.now()): number {
  // Croner accepts a Date for `startAt`; the next fire is computed relative to it.
  const c = new Cron(cron, { startAt: new Date(from - 1) });
  const next = c.nextRun();
  if (!next) {
    throw new Error(`cron expression "${cron}" has no future runs`);
  }
  c.stop();
  return next.getTime();
}

/** Map job id to a friendly period label used in the generated title. */
function jobIdToPeriodLabel(id: string): string {
  if (id === 'weekly_report') return 'Weekly update';
  if (id === 'monthly_report') return 'Monthly update';
  return 'Update';
}

/** Compute the report window's `since` based on the job's cadence. */
function computeSinceForJob(id: string): Date {
  const now = Date.now();
  if (id === 'monthly_report') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  // weekly_report and any custom job default to a 7-day window.
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

function toWire(id: string, rt: JobRuntime): SchedulerJob {
  return {
    id,
    enabled: rt.config.enabled,
    cron: rt.config.cron,
    audience_preset: rt.config.audience_preset,
    provider: rt.config.provider,
    model: rt.config.model ?? null,
    next_fire_at: rt.nextFireMs ? new Date(rt.nextFireMs).toISOString() : null,
  };
}
