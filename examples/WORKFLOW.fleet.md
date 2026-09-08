---
# claude-fleet integration workflow — Dispatch v1.4.19+
#
# Turns team-brain's `status: ready to ship` plan phases into autonomous
# Dispatch runs, each isolated in a claude-fleet-style git worktree
# (`<repo>/.worktrees/<slug>` on branch `agent/<slug>`) instead of a bare
# clone. Retires the manual `claude-fleet-brain-tasks` + `claude-fleet-start`
# loop for repos that want the daemon driving continuously instead of a
# once-a-morning batch launch.
#
# Drop next to the IMPLEMENTATION repo (not team-brain) and start with:
#   dispatch start --workflow ./WORKFLOW.fleet.md
#
# `claude-fleet-status` / `claude-fleet-ship` / `claude-fleet-clean` still
# work unchanged against the worktrees this creates — same directory
# layout, same `agent/<slug>` branch convention. Only the *dispatch* loop
# changes: the daemon claims + spawns instead of a human running
# `claude-fleet-start` each morning. Do NOT also run claude-fleet-start
# against the same repo while this workflow is active — both would try to
# claim/dispatch the same team-brain plans (see "Two dispatchers" in the
# integration notes this template was written from).
#
# Required prerequisites:
#   - This IS a git repo with an `agent/*` branch namespace free to use.
#   - Dispatch's hooks installed in the repo (or globally) so the Stop
#     hook fires — required for team-brain claim tracking via events, and
#     for `agent.runtime: claude-code-tmux` below if you enable it.

tracker:
  kind: team-brain
  # Absolute path (or relative to this file) to the team-brain checkout's
  # plans/ directory root — NOT the team-brain repo root itself.
  source: ../team-brain/plans
  # team-brain's lifecycle vocabulary (see team-brain/CONCEPT.md), not
  # Linear's Todo/In Progress — the tracker filters plan frontmatter
  # `status:` against these, case-insensitively.
  active_states: ["ready to ship"]
  terminal_states: ["implemented-and-synced", "archived", "resolved", "superseded"]

  # Claim by rewriting the plan's status: line before spawn, same idea as
  # Linear's assignee flip — just a file instead of an API call. No
  # assignee concept exists for team-brain, so assign_to_self /
  # unassigned_only are accepted but are no-ops here.
  claim_on_dispatch: true
  claim_state: "implemented-pending-pr"

polling:
  interval_ms: 30000

workspace:
  # Worktrees land under THIS repo's .worktrees/ — the exact layout
  # claude-fleet-start already uses, so claude-fleet-status/-ship/-clean
  # keep working against whatever this workflow creates.
  root: ./.worktrees

# NOTE: hooks: is a TOP-LEVEL key, a sibling of workspace: — NOT nested
# under it. (The workflow-loader doc comment says the same; the examples
# this template was drafted from nest it under workspace: instead, which
# the loader silently ignores — see daemon/src/workflow-loader.ts
# coerceConfig(): `coerceHooks(raw['hooks'])` reads the top level only.)
hooks:
  # `issue.identifier` here is the plan's path relative to team-brain's
  # plans/ root (e.g. "1st10s/mvp/phase-1-foundation") with slashes
  # sanitized to underscores for the directory name — $(basename "$PWD")
  # picks that sanitized key back up for the branch name.
  #
  # Hooks run as `bash -lc <script>` with cwd = the worktree path itself
  # (there's no hook *file*, so `$0` has no usable path) — REPO_ROOT is
  # derived as two levels up from $PWD, i.e. this assumes `workspace.root`
  # above stays exactly `<repo>/.worktrees` (the default). Hardcode an
  # absolute REPO_ROOT instead if you point workspace.root elsewhere.
  after_create: |
    set -euo pipefail
    REPO_ROOT="$(cd "$PWD/../.." && pwd)"
    git -C "$REPO_ROOT" worktree add "$PWD" -b "agent/$(basename "$PWD")" \
      || git -C "$REPO_ROOT" worktree add "$PWD" "agent/$(basename "$PWD")"
  before_remove: |
    set -euo pipefail
    REPO_ROOT="$(cd "$PWD/../.." && pwd)"
    git -C "$REPO_ROOT" worktree remove --force "$PWD" || true
    git -C "$REPO_ROOT" worktree prune
  timeout_ms: 60000

agent:
  # claude-code (default) spawns a headless `claude --print` subprocess per
  # turn — nothing to attach to, matches WORKFLOW.build.md.
  #
  # claude-code-tmux instead opens the worktree in a detached tmux pane
  # (`tmux attach -t dispatch-<slug>-<session>` while it's running) — the
  # claude-fleet-flavored option when you want to watch or take over a
  # stuck agent by hand instead of reading stderr. Requires Dispatch's
  # hooks installed in the worktree (Stop hook is the completion signal,
  # not process exit — see agent-runner.ts).
  runtime: claude-code
  max_concurrent_agents: 3
  turn_timeout_ms: 3600000
---

# Fleet build prompt

You are working on **{{ issue.identifier }}** (currently `{{ issue.state }}`),
a team-brain plan phase, in an isolated git worktree on branch
`agent/{{ issue.identifier }}` (slashes sanitized to underscores).

{{ issue.description }}

1. **Read the full phase spec above** — it's the plan file's body verbatim,
   objective through acceptance criteria.
2. **Implement it.** Follow this repo's own conventions (CLAUDE.md, existing
   patterns) over the plan's suggestions where they conflict on style.
3. **Test.** Run this repo's test suite; add coverage for new behavior.
4. **Commit.** Small, named commits on this branch — do not rebase or
   force-push.
5. **Stop here.** This workflow does not open a PR or touch team-brain's
   plan status beyond the claim already made at dispatch — a human runs
   `claude-fleet-ship` from the repo root when the branch looks ready,
   which pushes it and opens a draft PR (see "Who opens the PR" in the
   integration notes: intentionally a manual step, not automated here).

## When things don't go to plan

- **Spec is ambiguous or wrong.** Use `mcp__dispatch__ask_user` rather than
  guessing — this workflow has no ticket-comment channel back to a human
  the way the Linear templates do.
- **You get stuck.** Leave the workspace in whatever state it's in and
  call `mcp__dispatch__flag_blocked` with why. A human reviews via
  `claude-fleet-status` and either unblocks you or takes over the worktree
  directly.

## Constraints

- **Stay on this branch, in this worktree.** Don't touch other agents'
  worktrees or `main`.
- **Never force-push.**

{% if attempt %}

This is continuation attempt #{{ attempt }}. Re-read `git log --oneline` and
any `MEMORY.md` notes from the previous turn before resuming — don't redo
work that already landed.
{% endif %}
