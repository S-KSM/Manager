import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readEnvWithLegacy } from './config.js';
import type { LLMProviderName } from './llm/index.js';

/**
 * Persisted user settings for the LLM-powered "summary" features (headliner +
 * subgoal synthesizer + per-report defaults). Lives at
 * `${DISPATCH_HOME}/settings.json`. The file is the source of truth at
 * runtime; missing fields fall back to environment variables which then
 * fall back to hard-coded defaults — so an empty file behaves identically
 * to a fresh install.
 *
 * The macOS Settings → Providers tab edits this file via PATCH /settings.
 * The API key is write-only on the wire: GET /settings returns
 * `anthropicApiKeyConfigured: boolean` instead of the value, but the value is
 * still readable in-process via `getResolvedAnthropicApiKey()` so the
 * ClaudeProvider can authenticate.
 */
export interface PersistedSettings {
  headlineProvider?: LLMProviderName;
  headlineModel?: string;
  ollamaUrl?: string;
  /**
   * The Anthropic API key. Stored verbatim in `settings.json`. Never returned
   * from `GET /settings` — `serializeForWire()` redacts it to a boolean.
   */
  anthropicApiKey?: string;
}

/**
 * The wire shape returned from `GET /settings`. The API key is collapsed to a
 * boolean so it never round-trips back to a client (and so `kSecClassGenericPassword`
 * isn't required on the macOS side — the daemon is the only persistence layer).
 */
export interface SettingsWire {
  headlineProvider: LLMProviderName;
  headlineModel: string;
  ollamaUrl: string;
  anthropicApiKeyConfigured: boolean;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3:4b';
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

export class SettingsStore {
  private readonly path: string;
  private current: PersistedSettings;

  constructor(path: string) {
    this.path = path;
    this.current = readFromDisk(path);
  }

  /** Live snapshot of persisted-only fields (no env fallback applied). */
  raw(): PersistedSettings {
    return { ...this.current };
  }

  /**
   * Resolved provider, with env-var fallback and a final default of `ollama`.
   * Settings file > env var > default.
   */
  getResolvedProvider(): LLMProviderName {
    if (this.current.headlineProvider) return this.current.headlineProvider;
    const env = readEnvWithLegacy('DISPATCH_HEADLINE_PROVIDER', 'MANAGER_HEADLINE_PROVIDER');
    if (env === 'claude' || env === 'ollama') return env;
    return 'ollama';
  }

  /**
   * Resolved model. If the settings file specifies one, use it; otherwise the
   * env var; otherwise the per-provider hard-coded default. Returned model
   * always matches `getResolvedProvider()`'s namespace.
   */
  getResolvedModel(provider?: LLMProviderName): string {
    const effectiveProvider = provider ?? this.getResolvedProvider();
    if (this.current.headlineModel && this.current.headlineModel.length > 0) {
      return this.current.headlineModel;
    }
    const env = readEnvWithLegacy('DISPATCH_HEADLINE_MODEL', 'MANAGER_HEADLINE_MODEL');
    if (env && env.length > 0) return env;
    return effectiveProvider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_OLLAMA_MODEL;
  }

  /** Ollama base URL: settings file > `OLLAMA_URL` env > default localhost. */
  getResolvedOllamaUrl(): string {
    if (this.current.ollamaUrl && this.current.ollamaUrl.length > 0) {
      return this.current.ollamaUrl;
    }
    const env = process.env['OLLAMA_URL'];
    if (env && env.length > 0) return env;
    return DEFAULT_OLLAMA_URL;
  }

  /**
   * Anthropic API key for the Claude provider. Settings file value wins; if
   * absent, the daemon reads the standard `ANTHROPIC_API_KEY` env var. Returns
   * `undefined` when neither is set (the ClaudeProvider then throws
   * LLMConfigError on first use, which is the same behavior as before).
   */
  getResolvedAnthropicApiKey(): string | undefined {
    if (this.current.anthropicApiKey && this.current.anthropicApiKey.length > 0) {
      return this.current.anthropicApiKey;
    }
    return process.env['ANTHROPIC_API_KEY'] ?? undefined;
  }

  /** Wire shape with the API key redacted to a boolean. */
  serializeForWire(): SettingsWire {
    const provider = this.getResolvedProvider();
    return {
      headlineProvider: provider,
      headlineModel: this.getResolvedModel(provider),
      ollamaUrl: this.getResolvedOllamaUrl(),
      anthropicApiKeyConfigured: this.getResolvedAnthropicApiKey() !== undefined,
    };
  }

  /**
   * Apply a partial patch and persist. Validates each field; on first invalid
   * field throws an Error with a human-readable message that the HTTP layer
   * can hand back as a 400. Unknown keys are ignored, not rejected, so future
   * client versions don't break older daemons.
   *
   * `anthropicApiKey === ''` clears the stored key (so the user can blank it
   * out from the UI). `anthropicApiKey === undefined` leaves it untouched.
   */
  patch(input: Record<string, unknown>): void {
    const next: PersistedSettings = { ...this.current };

    if (input['headlineProvider'] !== undefined) {
      const v = input['headlineProvider'];
      if (v !== 'claude' && v !== 'ollama') {
        throw new Error("headlineProvider must be 'claude' or 'ollama'");
      }
      next.headlineProvider = v;
    }
    if (input['headlineModel'] !== undefined) {
      const v = input['headlineModel'];
      if (typeof v !== 'string') throw new Error('headlineModel must be a string');
      // Empty string clears the override.
      if (v.length === 0) delete next.headlineModel;
      else next.headlineModel = v;
    }
    if (input['ollamaUrl'] !== undefined) {
      const v = input['ollamaUrl'];
      if (typeof v !== 'string') throw new Error('ollamaUrl must be a string');
      if (v.length === 0) {
        delete next.ollamaUrl;
      } else {
        try {
          // Just validate parseability; don't normalize the trailing slash —
          // OllamaProvider already strips it.
          new URL(v);
        } catch {
          throw new Error('ollamaUrl must be a valid URL');
        }
        next.ollamaUrl = v;
      }
    }
    if (input['anthropicApiKey'] !== undefined) {
      const v = input['anthropicApiKey'];
      if (typeof v !== 'string') throw new Error('anthropicApiKey must be a string');
      if (v.length === 0) delete next.anthropicApiKey;
      else next.anthropicApiKey = v;
    }

    this.current = next;
    writeToDisk(this.path, next);
  }
}

function readFromDisk(path: string): PersistedSettings {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const out: PersistedSettings = {};
    if (obj['headlineProvider'] === 'claude' || obj['headlineProvider'] === 'ollama') {
      out.headlineProvider = obj['headlineProvider'];
    }
    if (typeof obj['headlineModel'] === 'string' && (obj['headlineModel'] as string).length > 0) {
      out.headlineModel = obj['headlineModel'] as string;
    }
    if (typeof obj['ollamaUrl'] === 'string' && (obj['ollamaUrl'] as string).length > 0) {
      out.ollamaUrl = obj['ollamaUrl'] as string;
    }
    if (
      typeof obj['anthropicApiKey'] === 'string' &&
      (obj['anthropicApiKey'] as string).length > 0
    ) {
      out.anthropicApiKey = obj['anthropicApiKey'] as string;
    }
    return out;
  } catch {
    // Corrupt file → behave as if it were empty. Don't auto-overwrite; the
    // user can fix the file or trigger a PATCH which will rewrite it.
    return {};
  }
}

function writeToDisk(path: string, value: PersistedSettings): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Pretty-print so users can read/diff the file by hand.
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
