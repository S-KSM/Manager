import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMRequestError, LLMUnreachableError } from '../../src/llm/index.js';
import { OllamaProvider } from '../../src/llm/ollama.js';

describe('OllamaProvider (OpenAI-compatible transport)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DISPATCH_LLM_BASE_URL'];
    delete process.env['OLLAMA_URL'];
  });

  it('happy path posts to /v1/chat/completions and returns choices[0].message.content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello from local llm' } }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://localhost:8080/v1');
    const out = await provider.generate({ system: 'sys', user: 'hi' });
    expect(out).toBe('hello from local llm');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('qwen3:8b');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('connection refused → LLMUnreachableError with mlx + ollama install hint', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://localhost:8080/v1');
    try {
      await provider.generate({ system: 's', user: 'u' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMUnreachableError);
      expect((err as Error).message).toContain('mlx_lm.server');
      expect((err as Error).message).toContain('brew install ollama');
      expect((err as Error).message).toContain('http://localhost:8080/v1');
    }
  });

  it('non-200 response → LLMRequestError with status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500, statusText: 'Server Error' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://localhost:8080/v1');
    try {
      await provider.generate({ system: 's', user: 'u' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRequestError);
      expect((err as LLMRequestError).status).toBe(500);
    }
  });

  it('honours base URL via constructor argument override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider('http://example.test:9999/v1');
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://example.test:9999/v1/chat/completions');
  });
});
