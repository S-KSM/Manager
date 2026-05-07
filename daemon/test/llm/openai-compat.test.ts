import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama.js';

/**
 * URL-precedence + normalization tests separated from the transport tests
 * so the ENV-mutation surface is contained.
 */
describe('OllamaProvider URL precedence + normalization', () => {
  beforeEach(() => {
    delete process.env['DISPATCH_LLM_BASE_URL'];
    delete process.env['OLLAMA_URL'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DISPATCH_LLM_BASE_URL'];
    delete process.env['OLLAMA_URL'];
  });

  function captureFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('DISPATCH_LLM_BASE_URL wins over OLLAMA_URL', async () => {
    process.env['DISPATCH_LLM_BASE_URL'] = 'http://dispatch.test:1/v1';
    process.env['OLLAMA_URL'] = 'http://ollama.test:2/v1';
    const fetchMock = captureFetch();
    const provider = new OllamaProvider();
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://dispatch.test:1/v1/chat/completions');
  });

  it('OLLAMA_URL wins over default when DISPATCH_LLM_BASE_URL is unset', async () => {
    process.env['OLLAMA_URL'] = 'http://ollama.test:11434/v1';
    const fetchMock = captureFetch();
    const provider = new OllamaProvider();
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://ollama.test:11434/v1/chat/completions');
  });

  it('default is mlx_lm.server when no env vars / overrides are set', async () => {
    const fetchMock = captureFetch();
    const provider = new OllamaProvider();
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8080/v1/chat/completions');
  });

  it('bare http://localhost:11434 is normalized to http://localhost:11434/v1', async () => {
    const fetchMock = captureFetch();
    const provider = new OllamaProvider('http://localhost:11434');
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('URL without /v1 in path gets /v1 appended', async () => {
    const fetchMock = captureFetch();
    const provider = new OllamaProvider('http://example.test:9999');
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://example.test:9999/v1/chat/completions');
  });

  it('URL already containing /v1 is left untouched (modulo trailing slash)', async () => {
    const fetchMock = captureFetch();
    const provider = new OllamaProvider('http://example.test:9999/v1/');
    await provider.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://example.test:9999/v1/chat/completions');
  });
});
