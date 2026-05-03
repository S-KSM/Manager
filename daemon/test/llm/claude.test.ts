import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../../src/llm/claude.js';
import { LLMConfigError, LLMRequestError } from '../../src/llm/index.js';

describe('ClaudeProvider', () => {
  const originalEnv = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalEnv;
    vi.restoreAllMocks();
  });

  it('happy path returns concatenated text from content blocks', async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
            { type: 'tool_use' }, // ignored
          ],
        }),
      },
    };
    const provider = new ClaudeProvider(fakeClient);
    const out = await provider.generate({ system: 'sys', user: 'hi' });
    expect(out).toBe('hello world');
    expect(fakeClient.messages.create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-7',
      max_tokens: 4096,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('passes through model + max_tokens overrides', async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      },
    };
    const provider = new ClaudeProvider(fakeClient);
    await provider.generate({
      system: 's',
      user: 'u',
      model: 'claude-opus-4-7',
      max_tokens: 100,
    });
    expect(fakeClient.messages.create).toHaveBeenCalledWith({
      model: 'claude-opus-4-7',
      max_tokens: 100,
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
    });
  });

  it('throws LLMConfigError when ANTHROPIC_API_KEY is missing and no client injected', async () => {
    const provider = new ClaudeProvider();
    await expect(provider.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
      LLMConfigError,
    );
  });

  it('wraps SDK errors into LLMRequestError preserving status', async () => {
    const sdkError = Object.assign(new Error('rate limited'), { status: 429 });
    const fakeClient = {
      messages: {
        create: vi.fn().mockRejectedValue(sdkError),
      },
    };
    const provider = new ClaudeProvider(fakeClient);
    try {
      await provider.generate({ system: 's', user: 'u' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRequestError);
      expect((err as LLMRequestError).status).toBe(429);
      expect((err as Error).message).toContain('rate limited');
    }
  });
});
