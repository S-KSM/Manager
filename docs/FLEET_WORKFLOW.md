# Fleet workflow — plan in team-brain, run in claude-fleet worktrees, watch in Dispatch

One loop, three repos. **team-brain** decides *what* to build (plan phases with a lifecycle `status:`), **claude-fleet** decides *where* it runs (a git worktree + branch per plan, optionally a tmux pane), and **Dispatch** is *who watches* (Radar cards, Intercept, approvals, skill promotion). Nothing below invents a second telemetry path — an orchestrator-spawned `claude` writes the same events a hand-launched one does.

This guide uses an implementation repo at `~/Code/1st10s` with team-brain at `~/Code/team-brain` and this repo (Dispatch) at `~/Code/Manager`. Substitute your paths.

## Prerequisites

- Dispatch installed (`bash bin/install.sh`) — the app in `/Applications`, the daemon under launchd, hooks + MCP wired into Claude Code.
- claude-fleet scripts on `PATH` (`cp ~/Code/agent_fleet/bin/* ~/.local/bin/`).
- `tmux`, `jq`, `gh` (authed), `git` with push access to the implementation repo.
- A team-brain checkout with at least one plan phase you're willing to let an agent implement.

## 0. Wire an implementation repo (once per repo)

```bash
cd ~/Code/1st10s
claude-fleet-install-dispatch --team-brain ~/Code/team-brain --dispatch ~/Code/Manager
```

This writes `.claude-fleet.conf` (`TEAM_BRAIN_DIR`), re-runs Dispatch's `hooks/install.sh`, and copies `examples/WORKFLOW.fleet.md` into the repo. Then:

1. Open `WORKFLOW.fleet.md`; confirm `tracker.source` points at the team-brain `plans/` directory and `workspace.root` is `./.worktrees`.
2. If the repo has no `CLAUDE.md`, copy `~/Code/agent_fleet/examples/CLAUDE.md.team-brain.example` to `CLAUDE.md` — it tells agents to commit small and stop before shipping.
3. Add `.worktrees/` to `.gitignore` (the fleet scripts do this automatically on first run).

The two sibling-directory guesses (`../team-brain`, `../Manager`) mean the flags are optional when the repos sit side by side.

## 1. Plan (team-brain)

```bash
cd ~/Code/team-brain && claude
```

- `/brainstorm <idea>` — explore before committing to anything.
- `/planning` — writes `plans/<namespace>/<feature>/phase-N.md`, each at `status: wip`.
- Resolve every open question, then flip a phase to **`status: ready to ship`** (spaced, exactly as team-brain's `CONCEPT.md` defines it).

`ready to ship` is the trigger for everything below. Both run modes read it; both move it to `implemented-pending-pr` when a plan is picked up.

## 2. Run

Pick one mode per repo. **Never run both against the same repo at once** — each claims the same plans.

### 2a. Batch mode — you launch, once a day

```bash
cd ~/Code/1st10s
claude-fleet-brain-tasks              # ready-to-ship plans → tasks.brain.txt
claude-fleet-start tasks.brain.txt    # worktree + tmux pane per plan, prompt: /implement <plan>
tmux attach -t claude-fleet           # Ctrl-b ←/→ switch pane · Ctrl-b z zoom · Ctrl-b d detach
```

Each pane exports `DISPATCH_WORKSTREAM=1st10s-<slug>`, so every agent appears as its own Radar card (the repo prefix keeps two projects with an `auth-modal` task apart).

### 2b. Autonomous mode — the daemon launches, continuously

The launchd daemon is observation-only and owns port 9876. Hand the port to a workflow daemon:

```bash
launchctl bootout gui/$UID/com.dispatch.daemon           # stop the observation-only daemon
cd ~/Code/1st10s
export DISPATCH_TEAM_BRAIN_DIR=~/Code/team-brain          # promoted skills also land in team-brain
node ~/Code/Manager/daemon/dist/index.js start --workflow ./WORKFLOW.fleet.md
```

Every `polling.interval_ms` (30 s) the daemon:

1. scans `plans/**` for `status: ready to ship`;
2. claims one by rewriting that line to `implemented-pending-pr` (only that line changes);
3. creates `.worktrees/<slug>` on branch `agent/<slug>` (the `hooks.after_create` in the workflow);
4. registers the Radar workstream with the plan's title and a tracker link;
5. spawns Claude with the plan body as the prompt — headless (`agent.runtime: claude-code`) or in a tmux pane you can attach to (`claude-code-tmux`);
6. repeats up to `agent.max_concurrent_agents`.

Turn completion in tmux mode is detected from the Stop hook's `session_end` event, so the hooks must be installed (step 0 does that).

To return to observation-only:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.dispatch.daemon.plist
```

## 3. Watch and steer (Dispatch)

Open Dispatch (`/Applications/Dispatch.app`).

- **Radar** — one card per workstream. In autonomous mode a green **Autonomous** strip above the kanban shows tracker · workflow · runtime · agent slots · running chips; cards carry an **Autonomous** badge and a tracker chip (click it → *Open plan*).
- **Attach** — right-click a card (tmux runtime) → *Attach in Terminal* or *Copy attach command* to take over an agent mid-flight. Same actions in the detail header.
- **Intercept** — *Intervene* on the detail view: nudge (advisory), redirect (hard course-correct), rollback (replay from a decision).
- **Approvals / questions** — agents that call `ask_user` or request approval surface a strip under the header; answer there and the agent unblocks.
- From a terminal: `claude-fleet-status` (ahead-of-main, dirty count, diff summary per worktree).

## 4. Ship

```bash
cd ~/Code/1st10s && claude-fleet-ship
```

Pushes every `agent/*` branch with commits ahead of `main`, opens a **draft PR** per branch, and stamps the matching plan `status: pr-open` + `related_pr: <#>`. Review and merge on GitHub as usual. Shipping is deliberately manual — the orchestrator never opens PRs.

## 5. Close the loop (team-brain)

After merge, in team-brain:

- `/wiki-sync <PR#>` — creates/flips the ADR, updates wiki pages, archives the plan. It can pull the agent's actual rationale instead of reconstructing it from the diff:

  ```bash
  curl -s "localhost:9876/workstreams/<workstream-id>/adr-material?min_confidence=0.8"
  # → { decisions: [{considered, choice, rationale, confidence}], memory: "<markdown>" }
  ```

- **Promote skills** — Dispatch → *Handbook* tab → *Promote* on a proposal. It's appended to the handbook **and**, when `DISPATCH_TEAM_BRAIN_DIR` is set, written to `team-brain/.agents/skills/<slug>/SKILL.md`; the tray shows the path. Run `/skills-sync` in team-brain to fan it out to every repo and surface.

## 6. Clean

```bash
cd ~/Code/1st10s && claude-fleet-clean
```

Kills the `claude-fleet` tmux session, removes `.worktrees/`, prunes git's worktree table. Branches survive; the next run reuses them.

## Reference

| Stage | Owner | Command / surface |
|---|---|---|
| Wire a repo | claude-fleet | `claude-fleet-install-dispatch` |
| Plan | team-brain | `/brainstorm`, `/planning`, `status: ready to ship` |
| Run (batch) | claude-fleet | `claude-fleet-brain-tasks` → `claude-fleet-start` |
| Run (autonomous) | Dispatch | `dispatch start --workflow ./WORKFLOW.fleet.md` |
| Watch | Dispatch | Radar · Attach · Intercept · approvals |
| Ship | claude-fleet | `claude-fleet-ship` |
| Close the loop | team-brain | `/wiki-sync`, `/skills-sync`, `GET /workstreams/:id/adr-material` |
| Clean | claude-fleet | `claude-fleet-clean` |

Related: [`ARCHITECTURE.md`](ARCHITECTURE.md) (orchestrator, `/orchestrator/state`, links, ADR material), [`../examples/WORKFLOW.fleet.md`](../examples/WORKFLOW.fleet.md) (the workflow template with every knob commented).
