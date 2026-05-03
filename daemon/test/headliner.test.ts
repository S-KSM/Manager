import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStore, type ManagerEvent } from '../src/event-store.js';
import { HeadlineStore } from '../src/headline-store.js';
import { Headliner } from '../src/headliner.js';
import {
  type LLMGenerateArgs,
  type LLMProvider,
  type LLMProviderName,
  LLMUnreachableError,
} from '../src/llm/index.js';
import { WorkstreamRegistry } from '../src/workstream.js';

function makeFakeProvider(impl: (args: LLMGenerateArgs) => Promise<string>): LLMProvider {
  return { name: 'ollama' as LLMProviderName, generate: impl };
}

function ev(over: Partial<ManagerEvent> & Pick<ManagerEvent, 'type' | 'workstream_id'>): ManagerEvent {
  return {
    ts: '2026-05-03T14:00:00.000Z',
    id: `e_${Math.random().toString(36).slice(2, 8)}`,
    payload: {},
    ...over,
  };
}

describe('Headliner', () => {
  let tmpDir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let store: HeadlineStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'headliner-'));
    registry = new WorkstreamRegistry(join(tmpDir, 'db.sqlite'));
    eventStore = new EventStore(join(tmpDir, 'events'));
    store = new HeadlineStore();
  });

  afterEach(async () => {
    registry.close();
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('regenerates a headline for a workstream with new events', async () => {
    registry.create('refactor-auth', 'Refactor auth');
    await eventStore.appendEvent(
      'refactor-auth',
      ev({
        workstream_id: 'refactor-auth',
        type: 'decision',
        payload: { choice: 'JWT', rationale: 'simpler stateless flow' },
      }),
    );
    await eventStore.appendEvent(
      'refactor-auth',
      ev({
        workstream_id: 'refactor-auth',
        type: 'tool_use',
        payload: { hook: 'post-tool-use', tool_name: 'Edit', tool_input: { file_path: '/src/auth/middleware.ts' } },
      }),
    );
    await eventStore.appendEvent(
      'refactor-auth',
      ev({
        workstream_id: 'refactor-auth',
        type: 'tool_use',
        payload: { hook: 'post-tool-use', tool_name: 'Read', tool_input: { file_path: '/src/auth/jwt.ts' } },
      }),
    );

    const seen: LLMGenerateArgs[] = [];
    const headliner = new Headliner({
      registry,
      eventStore,
      store,
      getProvider: () =>
        makeFakeProvider(async (args) => {
          seen.push(args);
          return 'Refactoring auth middleware to use JWT.';
        }),
    });
    await headliner.tick();

    const got = store.get('refactor-auth');
    expect(got).toBeDefined();
    expect(got?.text).toBe('Refactoring auth middleware to use JWT.');
    expect(got?.lastEventCount).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain('refactor-auth');
    expect(seen[0]?.user).toContain('decision: JWT');
  });

  it('skips regeneration when no new events arrived', async () => {
    registry.create('quiet', 'Quiet');
    for (let i = 0; i < 3; i++) {
      await eventStore.appendEvent(
        'quiet',
        ev({
          workstream_id: 'quiet',
          type: 'tool_use',
          payload: { hook: 'post-tool-use', tool_name: 'Read', tool_input: { file_path: `/x/${i}.ts` } },
        }),
      );
    }
    const generate = vi.fn().mockResolvedValue('Reading source files.');
    const headliner = new Headliner({
      registry,
      eventStore,
      store,
      getProvider: () => makeFakeProvider(generate),
    });
    await headliner.tick();
    await headliner.tick();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('skips retired workstreams', async () => {
    registry.create('done', 'Done');
    registry.setStatus('done', 'retired');
    await eventStore.appendEvent(
      'done',
      ev({ workstream_id: 'done', type: 'decision', payload: { choice: 'X' } }),
    );
    const generate = vi.fn().mockResolvedValue('whatever');
    const headliner = new Headliner({
      registry,
      eventStore,
      store,
      getProvider: () => makeFakeProvider(generate),
    });
    await headliner.tick();
    expect(generate).not.toHaveBeenCalled();
    expect(store.get('done')).toBeUndefined();
  });

  it('returns null silently when LLM is unreachable', async () => {
    registry.create('offline', 'Offline');
    for (let i = 0; i < 3; i++) {
      await eventStore.appendEvent(
        'offline',
        ev({
          workstream_id: 'offline',
          type: 'tool_use',
          payload: { hook: 'post-tool-use', tool_name: 'Bash', tool_input: { command: 'ls' } },
        }),
      );
    }
    const headliner = new Headliner({
      registry,
      eventStore,
      store,
      getProvider: () =>
        makeFakeProvider(async () => {
          throw new LLMUnreachableError('Ollama not reachable');
        }),
    });
    await expect(headliner.tick()).resolves.toBeUndefined();
    expect(store.get('offline')).toBeUndefined();
  });

  it('cleans up <think> blocks, wrapping quotes, and caps length', async () => {
    registry.create('messy', 'Messy');
    for (let i = 0; i < 3; i++) {
      await eventStore.appendEvent(
        'messy',
        ev({
          workstream_id: 'messy',
          type: 'tool_use',
          payload: { hook: 'post-tool-use', tool_name: 'Read', tool_input: { file_path: `/x/${i}.ts` } },
        }),
      );
    }
    const longSuffix = 'X'.repeat(150);
    const messy = `<think>some chain of thought</think>\n"Reading source files to plan a state migration. ${longSuffix}"`;
    const headliner = new Headliner({
      registry,
      eventStore,
      store,
      getProvider: () => makeFakeProvider(async () => messy),
    });
    await headliner.tick();
    const got = store.get('messy');
    expect(got).toBeDefined();
    expect(got?.text.startsWith('"')).toBe(false);
    expect(got?.text.length).toBeLessThanOrEqual(100);
  });
});
