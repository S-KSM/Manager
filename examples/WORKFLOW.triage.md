---
# Triage agent — Dispatch v1.4.15+
#
# Spawns Claude Code instances whose primary job is grooming a Linear backlog:
# dedupe, label, estimate, file new tickets when uncovered work surfaces. The
# triage agent does NOT do implementation work — it claims one issue at a
# time, decides whether the ticket is well-formed enough to delegate, and
# then either edits it (via the dispatch__file_ticket MCP tool + Linear
# comments) or hands off by moving the ticket to a downstream state.
#
# Use this template by copying it next to your repo and starting the daemon
# with `dispatch start --workflow ./WORKFLOW.triage.md`. Defaults to
# Linear; flip tracker.kind: mock to dry-run with the JSON fixture format.

tracker:
  kind: linear
  project_slug: my-project
  api_key: $LINEAR_API_KEY
  # The triage agent only operates on issues that are already labelled for
  # human review (or that need triage in the first place). Tighten these
  # to match your team's workflow — the defaults are illustrative.
  active_states: [Triage]
  terminal_states: [Done, Cancelled, Duplicate, Closed]

  # ─── Write-back (v1.4.10) ────────────────────────────────────────────
  # Triage agents must claim before editing so two daemons don't race the
  # same ticket. assign_to_self/unassigned_only default true once
  # claim_on_dispatch is on; setting them explicitly is just documentation.
  claim_on_dispatch: true
  assign_to_self: true
  unassigned_only: true
  # Optional: move the issue to a "being-triaged" state on claim. Leave
  # null/omitted to keep the ticket in Triage while the agent works.
  # claim_state: "In Triage"

  # Multi-instance recovery (v1.4.10.5). When two daemons share a Linear
  # API key, the strict unassigned_or_self filter could falsely double-claim.
  # The sweeper releases tickets assigned to self that haven't been touched
  # in 10 minutes AND aren't in the running map. Tune to your typical
  # triage-turn duration.
  stale_claim_ttl_ms: 600000

  # ─── Mirror to Radar (v1.4.12) ──────────────────────────────────────
  # Surface every triaged-or-newer issue in the macOS Kanban as a backlog
  # card the moment it appears in Linear, so the human can see the queue
  # building up before the daemon picks. Cap at 90 days so historical
  # noise doesn't swamp first-run.
  mirror_to_radar: true
  mirror_states: [Triage, Backlog, Todo]
  mirror_max_age_days: 90

polling:
  # Triage doesn't need a 5s loop — issues age in minutes, not seconds.
  interval_ms: 60000

workspace:
  # Triage rarely runs code, but agents still need a directory to put
  # transcripts + memory MD files in. Keep this off your real source tree.
  root: ~/code/dispatch-triage

agent:
  runtime: claude-code
  # One triage agent at a time is plenty — they're long-running but
  # I/O-bound (Linear round-trips dominate).
  max_concurrent_agents: 1
  # Triage turns are fast. If one runs >10 min something's stuck; let
  # the orchestrator retry rather than hold the lock.
  turn_timeout_ms: 600000
---

# Triage prompt

You are a triage agent. Your only job is to keep the Linear backlog tidy and
ready for downstream agents to act on. You do NOT write or modify code.

For ticket **{{ issue.identifier }}: {{ issue.title }}** (currently
`{{ issue.state }}`), do the following in order:

1. **Read the ticket.** Description, comments, links, labels, priority.
2. **Decide.** Pick exactly one outcome:
   - **a. Already triaged** — the ticket has clear scope, a single owner-
     team-could-pick-it-up unit of work, and the right labels. Move it to
     `Backlog` (or your team's "ready" state) and exit.
   - **b. Needs splitting** — the ticket bundles ≥2 unrelated chunks of
     work. Use the `dispatch__file_ticket` MCP tool to create the
     follow-on tickets, link them in a comment on the original, and
     close the original as Duplicate.
   - **c. Needs more info** — the ticket lacks reproduction steps, design
     context, or acceptance criteria. Post a comment listing the
     specific questions, label `needs-info`, and assign to the original
     reporter. Don't move state.
   - **d. Out of scope** — the ticket is for a different team or product
     area. Re-label, reassign, and exit.
3. **Document the decision.** Use `mcp__dispatch__emit_decision` with the
   four canonical fields so the methodology timeline shows why you
   picked the outcome you did.
4. **Stop.** Do not start implementation. The human (or a downstream
   workflow) picks up the next state.

{% if attempt %}

This is continuation attempt #{{ attempt }}. The previous turn left the
ticket in an indeterminate state. Re-read the comments + state and
resume from where the prior turn stopped. Do not re-do work that
already landed.
{% endif %}

## Rate limit

`dispatch__file_ticket` is rate-limited daemon-side (default 30 calls /
hour, configurable via `DISPATCH_FILE_TICKET_MAX_PER_HOUR`). If you hit
the limit, stop filing and post a single comment summarising the
remaining splits a human should create — don't loop on retries.
