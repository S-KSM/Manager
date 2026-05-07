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

/**
 * Optional overrides used to seed the provider with values that came from the
 * settings file rather than env vars. Either field may be omitted; in that
 * case the provider falls back to its existing env-var lookup.
 */
export interface ProviderOverrides {
  /** Anthropic API key. Wins over `ANTHROPIC_API_KEY`. */
  anthropicApiKey?: string;
  /** Ollama base URL. Wins over `OLLAMA_URL`. */
  ollamaUrl?: string;
}

/**
 * Factory returning a fresh provider for the given name. The optional second
 * argument lets callers (the headliner, the report endpoint) inject the
 * settings-store-resolved values so a user-typed API key / URL works without
 * them having to be in the daemon's process env.
 */
export function getProvider(name: LLMProviderName, overrides?: ProviderOverrides): LLMProvider {
  if (name === 'claude') return new ClaudeProvider(undefined, overrides?.anthropicApiKey);
  if (name === 'ollama') return new OllamaProvider(overrides?.ollamaUrl);
  throw new LLMConfigError(`Unknown LLM provider: ${name}`);
}

export { ClaudeProvider, OllamaProvider };
