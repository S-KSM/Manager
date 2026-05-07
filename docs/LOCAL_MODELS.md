# Local models for Updates

Dispatch's **Updates** feature (LLM-generated weekly / monthly summaries) runs against either the Anthropic API or a local model served by [Ollama](https://ollama.com). The daemon ships with both providers built in — you just pick one in the Generate Update sheet (or in the scheduler).

This doc covers wiring up a local model end to end. If you'd rather use the hosted Claude API, jump to [Alternative: Anthropic API](#alternative-anthropic-api).

## TL;DR

```sh
# 1. Install + start Ollama (one time)
brew install ollama
ollama serve            # leave running, or `brew services start ollama`

# 2. Pull a model (one time, ~5 GB for qwen3:8b)
ollama pull qwen3:8b

# 3. Generate an Update from the Dispatch app:
#    File menu → New Update (or the + button on the Updates pane)
#    → Provider: "Local (Ollama)"
#    → Model:    qwen3:8b   (or leave blank — qwen3:8b is the default)
#    → Generate
```

No daemon restart, no env var, no config file. The daemon talks to Ollama on demand at `http://localhost:11434`.

> You can also set the default provider/model app-wide in **Settings → Providers** (gear icon → Providers tab). New Updates inherit it; per-Update overrides still work in the Generate Update sheet. Headless setups that never open the macOS app should use the env-var route in [Pointing the daemon at a non-default Ollama URL](#pointing-the-daemon-at-a-non-default-ollama-url) and [Alternative: Anthropic API](#alternative-anthropic-api) below.

**Supported providers today:** `claude` (Anthropic API) and `ollama` (any model Ollama can serve). MLX-backed local inference is on the roadmap (v1.3, deferred) — track it in [`ROADMAP.md`](ROADMAP.md).

## Recommended models

The daemon defaults to `qwen3:8b` because it's the best quality-per-byte we've measured on Updates-style summarization. Anything Ollama can serve will work; some other reasonable picks:

| Model                  | Size  | Notes                                                       |
|------------------------|-------|-------------------------------------------------------------|
| `qwen3:8b`             | 5.2 GB| Default. Strong reasoning, good at structured prose.        |
| `qwen3:14b`            | 9 GB  | Better quality if you have the RAM (16 GB+ recommended).    |
| `llama3.1:8b`          | 4.9 GB| Faster on Apple Silicon, slightly weaker reasoning.         |
| `mistral-nemo:12b`     | 7 GB  | Good multilingual fallback.                                 |

Pull whichever you want, then type the model tag (e.g. `llama3.1:8b`) into the Model field of the Generate Update sheet.

## Pointing the daemon at a non-default Ollama URL

Only needed if you're running Ollama on a different host or port (e.g. on a beefier machine on your LAN, or behind a reverse proxy).

```sh
# Add to ~/.zshrc or ~/.bashrc, then re-launch the Dispatch daemon
export OLLAMA_URL=http://192.168.1.20:11434
```

Then bounce the daemon so it picks up the new env:

```sh
launchctl unload ~/Library/LaunchAgents/com.dispatch.daemon.plist
launchctl load   ~/Library/LaunchAgents/com.dispatch.daemon.plist
```

That's the only Ollama-related env var the daemon reads. Model selection happens per-request from the app, not at daemon startup, so you can switch between `qwen3:8b` and `llama3.1:8b` without any restart.

## Verify the next Update used Ollama

After generating an Update, the report header in the Updates pane shows the provider it ran against. You can also check the daemon log:

```sh
tail -n 50 ~/Library/Logs/dispatch.daemon.out.log | grep -i ollama
```

Or hit the daemon directly:

```sh
curl -s http://localhost:9876/reports | jq '.reports[0] | {provider, model, generated_at}'
```

You should see something like:

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "generated_at": "2026-05-03T18:42:01.103Z"
}
```

## Troubleshooting

**"Ollama not reachable at http://localhost:11434"** — Ollama isn't running. Open a terminal and `ollama serve`, or `brew services start ollama` to keep it running across reboots. The daemon raises this error verbatim with an install hint when the connection is refused — see `daemon/src/llm/ollama.ts`.

**"Ollama HTTP 404: model not found"** — you typed a model tag the local Ollama doesn't have. `ollama list` shows what's pulled; `ollama pull <tag>` to fetch a missing one.

**Generation hangs / takes 2+ minutes** — first run after `ollama serve` loads the model into RAM (slow). Subsequent runs are fast. If you're on a small machine, drop to a smaller model like `llama3.1:8b` or `qwen3:4b`.

**Output looks low-quality** — local 8B models lose some nuance vs. Claude. If the Update reads as generic, switch back to `claude` in the Generate Update sheet for that one report — Dispatch lets you mix providers per report.

## Alternative: Anthropic API

If you'd rather use the hosted Claude API (better quality, costs ~$0.05–0.20 per Update):

```sh
# Add to ~/.zshrc / ~/.bashrc, then re-launch the daemon
export ANTHROPIC_API_KEY=sk-ant-...
```

Bounce the daemon (same `launchctl` dance as above) and select `Provider: Claude` in the Generate Update sheet. Default model is `claude-sonnet-4-7`; override per request if you want a different snapshot. The key is read lazily — if it isn't set when you click Generate, the daemon returns a clear error and Dispatch surfaces "set ANTHROPIC_API_KEY" inline. Source: `daemon/src/llm/claude.ts`.

You can keep both configured and pick provider per Update. Nothing prevents mixing.

## What's wired where (for the curious)

- Provider factory: `daemon/src/llm/index.ts` (`getProvider('claude' | 'ollama')`)
- Ollama client: `daemon/src/llm/ollama.ts` — reads `OLLAMA_URL`, defaults to `http://localhost:11434`, default model `qwen3:8b`
- Claude client: `daemon/src/llm/claude.ts` — reads `ANTHROPIC_API_KEY`, default model `claude-sonnet-4-7`
- HTTP entry point: `POST /reports/generate` in `daemon/src/http-server.ts` — accepts `provider` and optional `model` per request
- Scheduler: `daemon/src/scheduler.ts` — picks provider/model from per-job config persisted in `~/.claude/dispatch/scheduler.json`
