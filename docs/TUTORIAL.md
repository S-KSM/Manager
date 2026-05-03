# Your first 30 minutes with Dispatch

This is a hands-on walkthrough. By the end you'll have two agents running in parallel, you'll have intercepted one mid-flight, and you'll have promoted a skill to the team Protocol. Estimate: 20–30 minutes.

> **Lexicon refresher** — Dispatch is mission control for AI agents. **Radar** = live multi-agent home view. **Trace** = methodology timeline. **Intercept** = mid-flight nudge / redirect / rollback. **Protocol** = team-wide skill broadcast. **Dossier** = per-workstream Markdown memory. The agent runtime is Claude Code; everything below assumes you've got `claude` on your `$PATH`.

## 0. Install (if you haven't)

One command, idempotent:

```sh
git clone git@github.com:S-KSM/Manager.git ~/Code/Manager
bash ~/Code/Manager/bin/install.sh
```

The installer wires Claude Code lifecycle hooks into `~/.claude/settings.json`, registers the MCP server, builds the daemon, and loads it as a launchd agent. Full Quickstart lives in [`README.md`](../README.md). To dry-run prereqs without changing anything: `bash bin/install.sh --check-only`.

## 1. Verify the daemon is up

The daemon binds to `localhost:9876`. From any terminal:

```sh
curl -s http://localhost:9876/health
```

Expect:

```json
{"ok":true,"version":"1.1.x","uptime_ms":...}
```

If you get `Connection refused`, kick it:

```sh
launchctl load ~/Library/LaunchAgents/com.manager.daemon.plist
# Logs:
tail -f ~/Library/Logs/manager.daemon.err.log
```

## 2. Open the macOS app

Launch **Manager** (the app's display name still says Manager until v1.2 — same binary, Dispatch brand). You'll see four areas:

- **Sidebar (left)** — workstream list, lifecycle actions (create / pause / retire), and navigation between Radar / Updates / Protocol panes.
- **The Radar (center, default view)** — digest rail at the top (today's headline numbers), team-floor cards for each active workstream, live event ticker. Glanceable status for every agent.
- **The Trace (right detail pane, click any card)** — forensic timeline of decision events for the selected workstream. Each row is a fork the agent made: what was *considered*, the *choice*, the *rationale*, a *confidence* score. Not a transcript — a methodology map.
- **The Dossier tab (within the detail pane)** — the Markdown memory file the agent maintains across sessions. This is the workstream's identity. Lives at `~/.claude/manager/memory/<workstream-id>.md` on disk.

The **Protocol** view (sidebar → Protocol) shows the team handbook plus pending skill proposals. **Updates** (sidebar → Updates) is where LLM-generated weekly / monthly summaries live; see [`LOCAL_MODELS.md`](LOCAL_MODELS.md) to wire that up.

The Radar is empty right now. Let's fix that.

## 3. Spin up your first workstream

Open a terminal, cd into any project, run `claude`:

```sh
cd ~/Code/some-project   # any git repo will do
claude
```

Two things happen:

1. The `SessionStart` hook fires. The daemon registers a workstream named after the project's git-root basename (override with `MANAGER_WORKSTREAM=foo claude`). A **Radar** card appears in the app within 1–2 seconds.
2. Claude Code's system prompt gets nudged to mention the Dispatch MCP tools (`emit_decision`, `propose_skill`, `update_memory`, etc.) and inlines the team Protocol handbook.

Now ask the agent to actually log its reasoning. Paste this prompt:

> Use the manager MCP tools to log your reasoning about how you'd refactor this README into shorter sections. Call `emit_decision` for each non-trivial fork. Don't actually edit any files yet.

Within a few seconds you should see decision rows pop into **The Trace** for this workstream — each row a structured fork with `considered` / `choice` / `rationale` / `confidence`. That's the data Dispatch is built around.

## 4. Spin up a second workstream in parallel

Open a **second** terminal, cd into a **different** project, run `claude` again:

```sh
cd ~/Code/another-project
claude
```

Back in the app: the team floor on the Radar now has **two cards** side by side. Each has its own Trace, its own Dossier, its own intercept queue. This is the core "ATC for agents" view — many agents, one supervisor. Run a third or fourth if you want to feel the floor fill up.

Try a different prompt in the second terminal so the two Traces look different:

> Use the manager MCP tools to log your decisions while you sketch out a test plan for the auth flow in this repo.

## 5. Watch the Trace

Click into either workstream's card. The right pane shows **The Trace** — a vertical timeline of decision events. Each row is one `emit_decision` call. The timeline is the answer to "what was the agent thinking and why?" — it's not a chat log, it's the methodology behind the chat log.

Useful things you can do here:

- **Click a row** → see the full rationale, parent decision (forks form a tree), and timestamp.
- **Sort / filter** by confidence to find the weak spots fast.
- **Subgoals + blocked flags** show up as their own row types (`emit_subgoal`, `flag_blocked`).

If the Trace is sparse, the agent is making decisions without telling Dispatch about them — nudge it (next step) to use the MCP tools more.

## 6. Send your first Intercept

Pick the more active workstream. With its detail pane open, hit the **Intercept** button (or its keyboard shortcut). You get three modes:

| Mode         | What it does                                                                                              | When to use                                          |
|--------------|-----------------------------------------------------------------------------------------------------------|------------------------------------------------------|
| **Nudge**    | Advisory message prepended to the agent's next turn ("FYI, consider X").                                  | The agent is on track but missing context.           |
| **Redirect**| Hard course-correct ("stop doing Y; do Z instead"). Same delivery mechanism, more imperative wording.      | The agent has gone off the rails and you've spotted it. |
| **Rollback**| Pick a past decision row from the Trace; Dispatch frames it as "we are returning to decision dec_05; here is what was considered then; here is the new hint" and queues that for the next turn. | The agent took the wrong fork three steps ago and you want to retry from there. |

Type a one-line nudge — e.g. *"prefer terse bullet headings, not paragraphs"* — and submit. Nothing visible happens immediately, because **Dispatch is a tap, not an interrupt**: observation never blocks the agent. The intercept lands in a queue.

On the agent's **next** turn, the `UserPromptSubmit` hook drains the queue and prepends your message to the prompt the agent sees. Send any follow-up message in the Claude Code terminal (e.g. "continue") — your nudge will be visible in the agent's view as a system-style note before the user message. The `intervention_delivered` event also lands in the Trace so you can confirm it was applied.

Rollback works the same way mechanically — it's "replay-with-hint", not session-state restoration. The agent gets a strongly-worded nudge to revisit the chosen decision; it doesn't time-travel its KV cache.

## 7. Promote a skill to the Protocol

Mid-session, ask the agent something like:

> If you've discovered a pattern that other workstreams should reuse — like a heuristic for breaking down refactors — call `propose_skill` with a title and 1–2 paragraph body.

The agent calls `propose_skill(title, body, source_decision_id?)`. Two things happen:

1. A `skill_proposed` event lands in this workstream's Trace.
2. The proposal lands in the **Protocol** view's "Pending" list (sidebar → Protocol).

Open the Protocol view. You'll see the proposal with the agent's title + body. Hit **Promote**. The handbook (plain Markdown at `~/.claude/manager/handbook.md`) gets the skill appended.

From that point on, **every new Claude Code session in any workstream** picks up the promoted skill. The mechanism: the `SessionStart` hook inlines the handbook (capped at 8 KB) into the agent's system prompt at the start of each session. Skills propagate without re-installing anything, without restarting the daemon, without telling agents one by one.

To verify, kill one of your existing `claude` sessions and start a fresh one in the same project. The new session has the promoted skill visible to the agent.

## 8. Wrap up

You've now got two workstreams with rich Traces, an intercept history, and a promoted skill in the team Protocol. Some loose-end housekeeping:

- **Pause a workstream** — sidebar context menu → **Pause**. The card stays on the Radar but greys out; new sessions are still recorded.
- **Retire a workstream** — sidebar → **Retire**. The card moves off the Radar into the retired list. Events and the Dossier stay on disk; nothing is destroyed.
- **Where Dossiers live on disk** — `~/.claude/manager/memory/<workstream-id>.md`. Plain Markdown, agent-curated via `update_memory`. You can read or edit it by hand if you want to seed an agent with context.
- **Where everything else lives** — `~/.claude/manager/db.sqlite` (workstream registry, intercept queue, skill proposals, saved Updates), `~/.claude/manager/events/<id>.jsonl` (append-only event log per workstream), `~/.claude/manager/handbook.md` (team Protocol). All local. No cloud, no auth, no remote access through v1.

## What's next

- **Generate your first Update** — sidebar → Updates → +. Pick a period, pick a provider (Claude API needs `ANTHROPIC_API_KEY`; local models need Ollama running — see [`LOCAL_MODELS.md`](LOCAL_MODELS.md)).
- **Schedule weekly / monthly Updates** — Updates pane → Settings → Scheduler. Cron expressions are croner-flavored.
- **Read the architecture** — [`ARCHITECTURE.md`](ARCHITECTURE.md) has the full event schema, HTTP+WebSocket contract, and component diagrams.
- **Check the roadmap** — [`ROADMAP.md`](ROADMAP.md) for what's coming (v1.2 code-layer rename, v1.5 mobile / remote auth, v2 non-coding workflows).

If you get stuck, check `~/Library/Logs/manager.daemon.err.log` first — the daemon is verbose about hook payloads, MCP calls, and provider errors.
