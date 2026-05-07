import {
  type LLMGenerateArgs,
  type LLMProvider,
  LLMRequestError,
  LLMUnreachableError,
} from './index.js';

const DEFAULT_MODEL = 'qwen3:8b';
/**
 * Default base URL points at `mlx_lm.server` (Apple's MLX engine), which is
 * the recommended local default on Apple Silicon. Ollama is still supported
 * — it speaks the same OpenAI-compatible surface — just point
 * `DISPATCH_LLM_BASE_URL` (or the Settings → Providers field) at
 * `http://localhost:11434/v1`.
 */
const DEFAULT_URL = 'http://localhost:8080/v1';
/** Ollama's bare port. We auto-append `/v1` so the legacy URL keeps working. */
const OLLAMA_BARE = 'http://localhost:11434';

/**
 * Local-LLM provider keyed on the OpenAI-compatible chat-completions API
 * (`POST /v1/chat/completions`). Works against `mlx_lm.server`,
 * `ollama serve` (which exposes `/v1/...` alongside its native API),
 * `llama-server` from llama.cpp, etc.
 *
 * Base-URL precedence (constructor argument wins, then env, then default):
 *   1. `baseUrl` constructor arg (settings.json `ollamaUrl`),
 *   2. `DISPATCH_LLM_BASE_URL` env,
 *   3. `OLLAMA_URL` env (legacy alias),
 *   4. `http://localhost:8080/v1` (mlx_lm.server default).
 *
 * URL normalization: a bare `http://localhost:11434` (Ollama's default port,
 * no path) and any URL whose path doesn't already contain `/v1` get `/v1`
 * appended. So a user upgrading from v1.2 with `OLLAMA_URL=http://...:11434`
 * keeps working.
 *
 * Errors are partitioned into:
 * - `LLMUnreachableError` for connection refused / DNS failures (server not
 *   running). Mapped to HTTP 503 by the report endpoint with an install hint.
 * - `LLMRequestError` for non-2xx responses or malformed payloads.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    const raw =
      baseUrl ?? process.env['DISPATCH_LLM_BASE_URL'] ?? process.env['OLLAMA_URL'] ?? DEFAULT_URL;
    this.baseUrl = normalizeBaseUrl(raw);
  }

  async generate(args: LLMGenerateArgs): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: args.model ?? DEFAULT_MODEL,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      stream: false,
    };
    if (args.max_tokens !== undefined) body['max_tokens'] = args.max_tokens;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LLMUnreachableError(
        `Local LLM not reachable at ${this.baseUrl}. Install: 'pip install mlx-lm && mlx_lm.server --port 8080', or 'brew install ollama && ollama serve'. Underlying: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      throw new LLMRequestError(
        `Local LLM HTTP ${response.status}: ${detail.slice(0, 200) || response.statusText}`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new LLMRequestError(
        `Local LLM returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    return extractText(parsed);
  }
}

/**
 * Append `/v1` when the URL is the bare Ollama default or any URL whose
 * path doesn't already include `/v1`. Trailing slashes are stripped so the
 * generate() call's `${baseUrl}/chat/completions` join is consistent.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed === OLLAMA_BARE) return `${trimmed}/v1`;
  try {
    const u = new URL(trimmed);
    if (!u.pathname.includes('/v1')) {
      return `${trimmed}/v1`;
    }
  } catch {
    // Fall through; if URL is unparseable, return the raw trimmed value
    // and let fetch surface the error.
  }
  return trimmed;
}

function extractText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const choice = obj.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === 'string' ? content : '';
}
