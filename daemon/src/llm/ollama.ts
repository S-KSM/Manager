import {
  type LLMGenerateArgs,
  type LLMProvider,
  LLMRequestError,
  LLMUnreachableError,
} from './index.js';

const DEFAULT_MODEL = 'qwen3:8b';
const DEFAULT_URL = 'http://localhost:11434';

/**
 * Ollama-backed provider. Talks to the local Ollama server's `/api/chat`
 * endpoint over HTTP. URL is overridable via the `OLLAMA_URL` env var. Uses
 * non-streaming responses for simplicity in v1.1; the report-generate flow
 * is one-shot and the cost of waiting for the full body is acceptable.
 *
 * Errors are partitioned into:
 * - `LLMUnreachableError` for connection refused / DNS failures (Ollama not
 *   running). Mapped to HTTP 503 by the report endpoint with an install hint.
 * - `LLMRequestError` for non-2xx responses or malformed payloads.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env['OLLAMA_URL'] ?? DEFAULT_URL;
  }

  async generate(args: LLMGenerateArgs): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/chat`;
    const body = {
      model: args.model ?? DEFAULT_MODEL,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      stream: false,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Connection refused, DNS failure, etc. Surface as unreachable with a
      // clear install hint so the macOS client can render it verbatim.
      throw new LLMUnreachableError(
        `Ollama not reachable at ${this.baseUrl}. Install: 'brew install ollama && ollama serve' then 'ollama pull ${DEFAULT_MODEL}'. Underlying: ${
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
        `Ollama HTTP ${response.status}: ${detail.slice(0, 200) || response.statusText}`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new LLMRequestError(
        `Ollama returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    return extractText(parsed);
  }
}

function extractText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as { message?: { content?: unknown } };
  const content = obj.message?.content;
  return typeof content === 'string' ? content : '';
}
