import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMRequestError, LLMUnreachableError } from '../../src/llm/index.js';
import { OllamaProvider } from '../../src/llm/ollama.js';

describe('OllamaProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path posts to /api/chat and returns message.content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: 'hello from ollama' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://localhost:11434');
    const out = await provider.generate({ system: 'sys', user: 'hi' });
    expect(out).toBe('hello from ollama');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('qwen3:8b');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('connection refused → LLMUnreachableError with install hint', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://localhost:11434');
    try {
      await provider.generate({ system: 's', user: 'u' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMUnreachableError);
      expect((err as Error).message).toContain('brew install ollama');
      expect((err as Error).message).toContain('http://localhost:11434');
    }
  });

  it('non-200 response → LLMRequestError with status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500, statusText: 'Server Error' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://localhost:11434');
    try {
      await provider.generate({ system: 's', user: 'u' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRequestError);
      expect((err as LLMRequestError).status).toBe(500);
    }
  });

  it('honours OLLAMA_URL via constructor argument override', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://example.test:9999');
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://example.test:9999/api/chat');
  });
});
