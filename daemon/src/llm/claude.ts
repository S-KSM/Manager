import Anthropic from '@anthropic-ai/sdk';
import {
  type LLMGenerateArgs,
  type LLMProvider,
  LLMConfigError,
  LLMRequestError,
} from './index.js';

const DEFAULT_MODEL = 'claude-sonnet-4-7';
const DEFAULT_MAX_TOKENS = 4096;

/** Minimal shape of the SDK we depend on; lets tests pass a stub client. */
interface AnthropicClientLike {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
    }) => Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Anthropic-backed provider. Reads the API key from `ANTHROPIC_API_KEY`. The
 * client is constructed lazily on the first `generate()` call so that simply
 * importing this module doesn't fail when the key is absent (e.g. during
 * `npm test`). The constructor accepts an optional pre-built client purely
 * for tests.
 */
export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude' as const;
  private client: AnthropicClientLike | null;

  constructor(client?: AnthropicClientLike) {
    this.client = client ?? null;
  }

  async generate(args: LLMGenerateArgs): Promise<string> {
    const client = this.ensureClient();
    const model = args.model ?? DEFAULT_MODEL;
    const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;
    let response: Awaited<ReturnType<AnthropicClientLike['messages']['create']>>;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: args.system,
        messages: [{ role: 'user', content: args.user }],
      });
    } catch (err) {
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : null;
      const message = err instanceof Error ? err.message : String(err);
      throw new LLMRequestError(`Anthropic API error: ${message}`, status);
    }
    return extractText(response);
  }

  private ensureClient(): AnthropicClientLike {
    if (this.client) return this.client;
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new LLMConfigError(
        'ANTHROPIC_API_KEY is not set. Export it in your shell before generating Claude reports.',
      );
    }
    this.client = new Anthropic({ apiKey }) as unknown as AnthropicClientLike;
    return this.client;
  }
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  if (!response || !Array.isArray(response.content)) return '';
  const parts: string[] = [];
  for (const block of response.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}
