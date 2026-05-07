# Local models for Updates and the in-app summaries

Dispatch's **Updates** feature (LLM-generated weekly / monthly summaries) and the in-app summary tickers (Headliner + SubgoalSynthesizer) run against either the Anthropic API or any OpenAI-compatible local LLM server. The daemon ships with both wired in — you just pick one in the Generate Update sheet, in **Settings → Providers**, or via env vars.

This doc covers wiring up a local model end to end. If you'd rather use the hosted Claude API, jump to [Alternative: Anthropic API](#alternative-anthropic-api).

## TL;DR — mlx_lm.server (recommended on Apple Silicon)

[`mlx_lm.server`](https://github.com/ml-explore/mlx-examples/tree/main/llms/mlx_lm) is Apple's MLX-backed inference server. On M-series silicon it's faster and lighter than the llama.cpp engine Ollama wraps; it speaks the OpenAI-compatible chat-completions API that Dispatch talks to as of v1.3.

```sh
# 1. Install + start the server (one time)
pip install mlx-lm

# 2. Run with a 4-bit Qwen2.5 3B (small, fast — good first try)
mlx_lm.server --port 8080 --model mlx-community/Qwen2.5-3B-Instruct-4bit

# 3. Open the Dispatch app → Settings → Providers
#    Provider:       Ollama (the family name for any OpenAI-compatible server)
#    Local LLM URL:  http://localhost:8080/v1  (the default)
#    Model:          mlx-community/Qwen2.5-3B-Instruct-4bit
```

That's it. Headliner and SubgoalSynthesizer pick the new settings up on their next ~30s tick; the Generate Update sheet picks them up on the next click.

> The provider name stays `ollama` for historical reasons — it's the family name for "any OpenAI-compatible local server" (mlx_lm.server, Ollama, llama.cpp). Internal contract; renaming it would churn the wire schema.

## Alternative: Ollama (still fully supported)

```sh
# 1. Install + start Ollama
brew install ollama
ollama serve            # leave running, or `brew services start ollama`

# 2. Pull a model
ollama pull qwen3:8b

# 3. Settings → Providers
#    Local LLM URL:  http://localhost:11434          (auto-promoted to /v1)
#    Model:          qwen3:8b
```

Dispatch v1.3 talks to Ollama on its OpenAI-compat surface (`/v1/chat/completions`), not the legacy `/api/chat`. A bare `http://localhost:11434` (or any URL whose path doesn't include `/v1`) is auto-normalized to `http://localhost:11434/v1` so existing v1.2 setups upgrade transparently.

## Pointing the daemon at a non-default URL

Two ways:

1. **Settings → Providers** in the app — preferred for desktop installs.
2. **Env var** — for headless setups (CI, the daemon running on a beefier LAN host, etc.).

```sh
# In ~/.zshrc / ~/.bashrc, then re-launch the Dispatch daemon
export DISPATCH_LLM_BASE_URL=http://192.168.1.20:8080/v1
```

`DISPATCH_LLM_BASE_URL` wins over the settings file. The legacy `OLLAMA_URL` env var is still honored as a fallback so existing v1.2 configurations keep working.

Bounce the daemon to pick up env changes:

```sh
launchctl unload ~/Library/LaunchAgents/com.dispatch.daemon.plist
launchctl load   ~/Library/LaunchAgents/com.dispatch.daemon.plist
```

## Recommended models

| Model                                          | Size  | Notes                                                       |
|------------------------------------------------|-------|-------------------------------------------------------------|
| `mlx-community/Qwen2.5-3B-Instruct-4bit`       | ~2 GB | Default mlx_lm.server pick. Strong reasoning for size.      |
| `mlx-community/Qwen2.5-7B-Instruct-4bit`       | ~4 GB | Better quality if you have the RAM. Apple Silicon optimized.|
| `qwen3:8b` (Ollama)                            | 5.2 GB| Default for Ollama users. Strong on structured prose.       |
| `qwen3:14b` (Ollama)                           | 9 GB  | Better quality, needs 16 GB+ RAM.                           |
| `llama3.1:8b` (Ollama)                         | 4.9 GB| Faster, slightly weaker reasoning.                          |

## Verify the next Update used your local model

After generating an Update, the report header in the Updates pane shows the provider it ran against. You can also check the daemon log:

```sh
tail -n 50 ~/Library/Logs/dispatch.daemon.out.log | grep -i 'local\|llm'
```

Or hit the daemon directly:

```sh
curl -s http://localhost:9876/reports | jq '.reports[0] | {provider, model, generated_at}'
```

You should see something like:

```json
{
  "provider": "ollama",
  "model": "mlx-community/Qwen2.5-3B-Instruct-4bit",
  "generated_at": "2026-05-07T18:42:01.103Z"
}
```

## Troubleshooting

**"Local LLM not reachable at http://localhost:8080/v1"** — `mlx_lm.server` (or Ollama) isn't running. Start it; the daemon raises this error verbatim with an install hint when the connection is refused — see `daemon/src/llm/ollama.ts`.

**"Local LLM HTTP 404: model not found"** — you typed a model id the local server doesn't have. For mlx_lm.server, the model loads on first request — the first generation may take a minute to download. For Ollama, `ollama list` shows what's pulled; `ollama pull <tag>` to fetch one.

**Generation hangs / takes 2+ minutes** — first run after the server starts loads the model into RAM (slow). Subsequent runs are fast. If you're on a small machine, drop to a smaller 4-bit MLX model.

**Output looks low-quality** — local 3B–8B models lose some nuance vs. Claude. If the Update reads as generic, switch back to `claude` in the Generate Update sheet for that one report — Dispatch lets you mix providers per report.

## Alternative: Anthropic API

If you'd rather use the hosted Claude API (better quality, costs ~$0.05–0.20 per Update):

1. Open the Dispatch app → **Settings → Providers** → paste your `sk-ant-...` key into the Anthropic API key field → Save. The key is stored in `~/.claude/dispatch/settings.json` with mode `0600` and never returned by the daemon once saved.

Or, headless / via env var:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
launchctl unload ~/Library/LaunchAgents/com.dispatch.daemon.plist
launchctl load   ~/Library/LaunchAgents/com.dispatch.daemon.plist
```

Then select `Provider: Claude` in the Generate Update sheet. Default model is `claude-sonnet-4-7`; override per request if you want a different snapshot. Source: `daemon/src/llm/claude.ts`.

You can keep both configured and pick provider per Update. Nothing prevents mixing.

## What's wired where (for the curious)

- Provider factory: `daemon/src/llm/index.ts` (`getProvider('claude' | 'ollama', overrides?)`)
- Local LLM client: `daemon/src/llm/ollama.ts` — OpenAI-compat `/v1/chat/completions`, base URL precedence `DISPATCH_LLM_BASE_URL` > settings > `OLLAMA_URL` > `http://localhost:8080/v1`, default model `qwen3:8b`
- Claude client: `daemon/src/llm/claude.ts` — reads `ANTHROPIC_API_KEY` (or settings → Providers), default model `claude-sonnet-4-7`
- HTTP entry point: `POST /reports/generate` in `daemon/src/http-server.ts` — accepts `provider` and optional `model` per request
- Scheduler: `daemon/src/scheduler.ts` — picks provider/model from per-job config persisted in `~/.claude/dispatch/scheduler.json`
- In-app summary tickers: `daemon/src/headliner.ts`, `daemon/src/subgoal-synthesizer.ts`
