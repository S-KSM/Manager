---
# Build agent — Dispatch v1.4.17+
#
# Spawns Claude Code instances that pick a Linear ticket, write the code,
# open a PR, and close the loop by transitioning the ticket — no human
# touch required for green-path issues. Pairs with WORKFLOW.triage.md
# (groomers feed work into Todo; this template picks it up from there).
#
# Drop next to your repo and start with:
#   dispatch start --workflow ./WORKFLOW.build.md
#
# Required prerequisites in the workspace:
#   - `gh` CLI installed + authed
#   - `git` configured with push credentials for `origin`
#   - The repo's CI runs on PR open (Dispatch doesn't trigger CI itself)

tracker:
  kind: linear
  project_slug: my-project
  api_key: $LINEAR_API_KEY
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Duplicate, Closed]

  # Claim before spawn so two daemons don't race the same ticket.
  claim_on_dispatch: true
  assign_to_self: true
  unassigned_only: true
  claim_state: "In Progress"

  # Stale-claim recovery — releases tickets owned by a previous-instance
  # crash after 10 min of no activity.
  stale_claim_ttl_ms: 600000

  # Mirror to Radar so the human sees the queue building up.
  mirror_to_radar: true
  mirror_states: [Backlog, Todo, In Progress]
  mirror_max_age_days: 90

polling:
  interval_ms: 30000

workspace:
  # Each ticket gets its own clone under here. Hooks below run inside
  # the per-ticket workspace.
  root: ~/code/dispatch-build

# hooks: is a top-level key (a sibling of workspace:, not nested under it —
# the loader reads raw['hooks'] at the top level; a nested copy is silently
# ignored).
hooks:
  # Clone fresh per ticket so the agent works in isolation. Use a
  # sparse / shallow clone if your repo is huge.
  after_create: |
    set -euo pipefail
    git clone --depth 50 git@github.com:YOU/YOUR_REPO.git .
    git checkout -b "dispatch/$DISPATCH_WORKSTREAM"
  # before_run keeps the workspace fresh between continuation turns —
  # rebases on top of main so the agent doesn't merge stale code.
  before_run: |
    set -euo pipefail
    git fetch origin main
    git rebase origin/main || true
  # 5 min for clone, plenty for rebase.
  timeout_ms: 300000

agent:
  runtime: claude-code
  # Concurrency: tune to your CI's parallelism. 2 means at most 2
  # tickets in flight, so at most 2 PRs open per loop.
  max_concurrent_agents: 2
  # Build turns can be long — generous timeout; orchestrator retries
  # on stall.
  turn_timeout_ms: 3600000
---

# Build prompt

You are a build agent for **{{ issue.identifier }}: {{ issue.title }}**
(currently `{{ issue.state }}`).

You are working in a fresh per-ticket workspace, on a branch called
`dispatch/{{ issue.identifier }}`. Your job is to ship this ticket end-to-
end without a human in the loop:

1. **Read the ticket.** Description, comments, linked issues, labels.
2. **Plan briefly.** Write a 3–5 bullet plan to `MEMORY.md` via
   `mcp__dispatch__update_memory` so the human can audit your reasoning
   later. If the ticket is ambiguous, use `mcp__dispatch__ask_user` —
   don't guess.
3. **Implement.** Write the code. Run the existing test suite (check
   the repo's README / CONTRIBUTING.md for the command). Add tests for
   new behaviour. Commit small, named commits.
4. **Open the PR.** Once `git status` is clean and tests pass, call:

   ```
   mcp__dispatch__open_pr({
     "title": "feat: <describe in 60 chars>",
     "body": "...PR description, links to {{ issue.url }}...",
     "base": "main"
   })
   ```

   The tool refuses if your tree is dirty or you're on `main`/`master`.
5. **Close the loop.** Once the PR is open, call:

   ```
   mcp__dispatch__transition_ticket({
     "state": "In Review",
     "comment": "PR opened: <url from open_pr>"
   })
   ```

   This moves the Linear ticket to "In Review" and posts the PR url as
   a comment. The human takes over from there (review, merge, mark Done
   in Linear → reverse-sync flips the workstream to retired).

## When things don't go to plan

- **Tests fail and you can't fix them.** Don't open a PR. Instead:

  ```
  mcp__dispatch__transition_ticket({
    "state": "Needs Review",
    "comment": "Got stuck on <X>. Test output: <tail>. Workspace: <path>."
  })
  ```

- **Ticket scope is wrong.** Surface it via
  `mcp__dispatch__ask_user` — don't ship the wrong feature. If splitting
  is needed, file the follow-on tickets via
  `mcp__dispatch__file_ticket` and transition the original to
  `Needs Review`.

- **Discovered uncovered work.** File new tickets via
  `mcp__dispatch__file_ticket` (rate-limited to 30/hour daemon-side).

## Constraints

- **Never push to `main` / `master`.** `open_pr` enforces this; double-
  check before you commit.
- **Never force-push.** If a rebase fails, `transition_ticket` to
  `Needs Review` and let a human resolve.
- **Stay in your workspace.** Don't `cd` outside it; don't touch other
  Dispatch workstreams.

{% if attempt %}

This is continuation attempt #{{ attempt }}. The previous turn ended
without opening a PR or transitioning the ticket. Re-read `MEMORY.md` +
`git log --oneline` to see what already landed; resume from there.
{% endif %}
