import type { ManagerEvent } from './event-store.js';
import type { ReportContext } from './report-engine.js';

export interface RenderUserPromptArgs {
  ctx: ReportContext;
  audience_label: string;
  period_label: string;
}

/**
 * Render a `ReportContext` plus framing into the deterministic user prompt the
 * LLM sees. Kept separate from `report-engine.ts` so tests can exercise the
 * rendering without re-running event/memory I/O, and so the scheduler can
 * reuse the exact same template the on-demand endpoint does.
 */
export function renderUserPrompt(args: RenderUserPromptArgs): string {
  const { ctx, audience_label, period_label } = args;
  const md = renderContext(ctx);
  return `Below is the structured context for a ${audience_label} update covering the period ${ctx.since}..${ctx.until}. Write the ${period_label}.\n\n${md}`;
}

/** Pure markdown rendering of the report context — exported for tests. */
export function renderContext(ctx: ReportContext): string {
  const out: string[] = [];
  out.push(`# Report context (period ${ctx.since} → ${ctx.until})`);
  if (ctx.workstreams.length === 0) {
    out.push('');
    out.push('(no active workstreams in this window)');
    return `${out.join('\n')}\n`;
  }
  for (const ws of ctx.workstreams) {
    out.push('');
    out.push(`## ${ws.title} (${ws.id})`);
    out.push(`- Status: ${ws.status}`);
    out.push(`- Current sub-goal: ${ws.current_subgoal ?? '—'}`);
    out.push(`- Latest confidence: ${formatConfidence(ws.latest_confidence)}`);
    out.push(`- Needs attention: ${ws.needs_attention ? 'yes' : 'no'}`);
    out.push(`- Shipped (decisions in window): ${ws.shipped_count}`);
    out.push(`- Active time: ${formatActiveSeconds(ws.active_seconds)}`);
    out.push('');
    out.push('### Decisions');
    if (ws.decisions_in_window.length === 0) {
      out.push('(none)');
    } else {
      for (const d of ws.decisions_in_window) {
        out.push(`- ${formatDecision(d)}`);
      }
    }
    out.push('');
    out.push('### Blockers');
    if (ws.blockers_in_window.length === 0) {
      out.push('(none)');
    } else {
      for (const b of ws.blockers_in_window) {
        out.push(`- ${formatBlocker(b)}`);
      }
    }
    out.push('');
    out.push('### Memory excerpt');
    out.push(
      ws.memory_excerpt && ws.memory_excerpt.trim().length > 0 ? ws.memory_excerpt : '(none)',
    );
    out.push('');
    out.push('---');
  }
  return `${out.join('\n')}\n`;
}

function formatConfidence(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function formatActiveSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h${remMinutes}m`;
}

interface DecisionPayload {
  considered?: unknown;
  choice?: unknown;
  rationale?: unknown;
  confidence?: unknown;
}

function formatDecision(ev: ManagerEvent): string {
  const p = (ev.payload ?? {}) as DecisionPayload;
  const considered = Array.isArray(p.considered)
    ? p.considered.filter((x): x is string => typeof x === 'string').join(', ')
    : '';
  const choice = typeof p.choice === 'string' ? p.choice : '?';
  const rationale = typeof p.rationale === 'string' ? p.rationale : '';
  const confidence =
    typeof p.confidence === 'number' && Number.isFinite(p.confidence)
      ? ` (confidence ${Math.round(p.confidence * 100)}%)`
      : '';
  const consideredPart = considered.length > 0 ? `considered: ${considered} — ` : '';
  const rationalePart = rationale.length > 0 ? ` — because: ${rationale}` : '';
  return `${consideredPart}chose: ${choice}${rationalePart}${confidence}`;
}

function formatBlocker(ev: ManagerEvent): string {
  const reason =
    ev.payload && typeof ev.payload === 'object'
      ? (ev.payload as { reason?: unknown }).reason
      : undefined;
  const ts = typeof ev.ts === 'string' ? ev.ts : '?';
  return `${ts}: ${typeof reason === 'string' ? reason : '(no reason)'}`;
}
