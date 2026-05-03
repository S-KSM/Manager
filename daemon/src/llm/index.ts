import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

/**
 * Common LLM provider interface used by report generation. Each provider
 * encapsulates its transport and credential handling and returns the
 * assistant's body text — no streaming for v1.1 simplicity.
 */
export interface LLMGenerateArgs {
  system: string;
  user: string;
  model?: string;
  max_tokens?: number;
}

export type LLMProviderName = 'claude' | 'ollama';

export interface LLMProvider {
  name: LLMProviderName;
  generate(args: LLMGenerateArgs): Promise<string>;
}

/**
 * Thrown when a provider is unusable due to local configuration: missing API
 * key for Claude, etc. The HTTP layer maps this to 500 with a clear message
 * so the macOS client can surface "set ANTHROPIC_API_KEY".
 */
export class LLMConfigError extends Error {
  readonly code = 'LLM_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'LLMConfigError';
  }
}

/**
 * Thrown when a provider's network endpoint is not reachable: Ollama not
 * running, etc. The HTTP layer maps this to 503 so the client can show a
 * one-line install hint.
 */
export class LLMUnreachableError extends Error {
  readonly code = 'LLM_UNREACHABLE';
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnreachableError';
  }
}

/** Generic provider error (HTTP non-2xx, malformed payload, etc.). */
export class LLMRequestError extends Error {
  readonly code = 'LLM_REQUEST';
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LLMRequestError';
    this.status = status;
  }
}

/** Factory returning a fresh provider for the given name. */
export function getProvider(name: LLMProviderName): LLMProvider {
  if (name === 'claude') return new ClaudeProvider();
  if (name === 'ollama') return new OllamaProvider();
  throw new LLMConfigError(`Unknown LLM provider: ${name}`);
}

export { ClaudeProvider, OllamaProvider };
