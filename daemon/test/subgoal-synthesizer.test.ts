import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore, type ManagerEvent } from '../src/event-store.js';
import { SubgoalSynthesizer, detectToolRuns, cleanGoal } from '../src/subgoal-synthesizer.js';
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

let counter = 0;
function ev(
  over: Partial<ManagerEvent> & Pick<ManagerEvent, 'type' | 'workstream_id'>,
): ManagerEvent {
  counter += 1;
  const ts = new Date(Date.UTC(2026, 4, 3, 14, 0, 0) + counter * 1000).toISOString();
  return {
    ts,
    id: `e_${counter.toString(36).padStart(4, '0')}`,
    payload: {},
    ...over,
  };
}

function tool(
  workstreamId: string,
  name: string,
  extra: Record<string, unknown> = {},
): ManagerEvent {
  return ev({
    workstream_id: workstreamId,
    type: 'tool_use',
    payload: {
      hook: 'post-tool-use',
      tool_name: name,
      tool_input: extra,
    },
  });
}

describe('SubgoalSynthesizer', () => {
  let tmpDir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;

  beforeEach(async () => {
    counter = 0;
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-'));
    registry = new WorkstreamRegistry(join(tmpDir, 'db.sqlite'));
    eventStore = new EventStore(join(tmpDir, 'events'));
  });

  afterEach(async () => {
    registry.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('detectToolRuns', () => {
    it('finds a single run when all events are tool_use post', () => {
      const ws = 'w';
      const events = Array.from({ length: 10 }, () => tool(ws, 'Read', { file_path: '/a' }));
      const runs = detectToolRuns(events, 8);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.events).toHaveLength(10);
      expect(runs[0]!.anchor).toMatch(/^e_.*\.\.e_.*$/);
    });

    it('skips runs shorter than threshold', () => {
      const ws = 'w';
      const events = Array.from({ length: 5 }, () => tool(ws, 'Read'));
      expect(detectToolRuns(events, 8)).toHaveLength(0);
    });

    it('breaks runs on non-tool_use event (e.g. decision)', () => {
      const ws = 'w';
      const before = Array.from({ length: 9 }, () => tool(ws, 'Read'));
      const decision = ev({ workstream_id: ws, type: 'decision', payload: { choice: 'A' } });
      const after = Array.from({ length: 8 }, () => tool(ws, 'Edit'));
      const runs = detectToolRuns([...before, decision, ...after], 8);
      expect(runs).toHaveLength(2);
      expect(runs[0]!.events).toHaveLength(9);
      expect(runs[1]!.events).toHaveLength(8);
      expect(runs[0]!.anchor).not.toEqual(runs[1]!.anchor);
    });

    it('ignores pre-tool-use events when counting (only post counts)', () => {
      const ws = 'w';
      const events: ManagerEvent[] = [];
      for (let i = 0; i < 10; i += 1) {
        events.push(
          ev({
            workstream_id: ws,
            type: 'tool_use',
            payload: { hook: 'pre-tool-use', tool_name: 'Read' },
          }),
        );
        events.push(tool(ws, 'Read'));
      }
      const runs = detectToolRuns(events, 8);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.events).toHaveLength(10); // only post-tool-use
    });
  });

  describe('summarize + tick', () => {
    it('writes a synthesized subgoal_push for a run that exceeds threshold', async () => {
      const ws = 'feat-x';
      registry.create(ws, 'Feature X');
      for (let i = 0; i < 8; i += 1) {
        await eventStore.appendEvent(ws, tool(ws, 'Read', { file_path: `/src/${i}.ts` }));
      }
      const seen: LLMGenerateArgs[] = [];
      const synth = new SubgoalSynthesizer({
        registry,
        eventStore,
        getProvider: () =>
          makeFakeProvider(async (args) => {
            seen.push(args);
            return 'Reading the request path to find the bug.';
          }),
      });
      await synth.tick();

      const { events } = await eventStore.readEvents(ws);
      const synthEv = events.find((e) => e.type === 'subgoal_push');
      expect(synthEv).toBeDefined();
      expect(synthEv!.payload).toMatchObject({
        goal: 'Reading the request path to find the bug.',
        source: 'synthesized',
      });
      expect(typeof (synthEv!.payload as Record<string, unknown>)['synth_anchor']).toBe('string');
      expect(synthEv!.id).toMatch(/^synth-/);
      expect(seen).toHaveLength(1);
    });

    it('is idempotent across restart — same run is summarized exactly once', async () => {
      const ws = 'feat-y';
      registry.create(ws, 'Feature Y');
      for (let i = 0; i < 8; i += 1) {
        await eventStore.appendEvent(ws, tool(ws, 'Edit', { file_path: `/x/${i}.ts` }));
      }
      let calls = 0;
      const provider = makeFakeProvider(async () => {
        calls += 1;
        return 'Editing files in /x.';
      });
      const synth1 = new SubgoalSynthesizer({ registry, eventStore, getProvider: () => provider });
      await synth1.tick();
      // Simulate restart: brand-new instance reads same event log.
      const synth2 = new SubgoalSynthesizer({ registry, eventStore, getProvider: () => provider });
      await synth2.tick();

      const { events } = await eventStore.readEvents(ws);
      const synths = events.filter(
        (e) =>
          e.type === 'subgoal_push' &&
          (e.payload as Record<string, unknown>)['source'] === 'synthesized',
      );
      expect(synths).toHaveLength(1);
      expect(calls).toBe(1);
    });

    it('skips when LLM is unreachable', async () => {
      const ws = 'feat-z';
      registry.create(ws, 'Feature Z');
      for (let i = 0; i < 8; i += 1) {
        await eventStore.appendEvent(ws, tool(ws, 'Read'));
      }
      const synth = new SubgoalSynthesizer({
        registry,
        eventStore,
        getProvider: () =>
          makeFakeProvider(async () => {
            throw new LLMUnreachableError('ollama down');
          }),
      });
      await synth.tick();
      const { events } = await eventStore.readEvents(ws);
      expect(events.every((e) => e.type === 'tool_use')).toBe(true);
    });

    it('synthesizes multiple runs separated by a real subgoal/decision', async () => {
      const ws = 'feat-multi';
      registry.create(ws, 'Multi');
      for (let i = 0; i < 8; i += 1) {
        await eventStore.appendEvent(ws, tool(ws, 'Read', { file_path: `/a/${i}` }));
      }
      await eventStore.appendEvent(
        ws,
        ev({ workstream_id: ws, type: 'decision', payload: { choice: 'X' } }),
      );
      for (let i = 0; i < 8; i += 1) {
        await eventStore.appendEvent(ws, tool(ws, 'Edit', { file_path: `/b/${i}` }));
      }
      let n = 0;
      const synth = new SubgoalSynthesizer({
        registry,
        eventStore,
        getProvider: () =>
          makeFakeProvider(async () => {
            n += 1;
            return `Run ${n}.`;
          }),
      });
      await synth.tick();
      const { events } = await eventStore.readEvents(ws);
      const synths = events.filter(
        (e) =>
          e.type === 'subgoal_push' &&
          (e.payload as Record<string, unknown>)['source'] === 'synthesized',
      );
      expect(synths).toHaveLength(2);
    });
  });

  describe('cleanGoal', () => {
    it('strips think blocks, quotes, and clamps length', () => {
      expect(cleanGoal('<think>foo</think>\n"Wiring the field in."')).toBe('Wiring the field in.');
      const long = 'a'.repeat(150);
      expect(cleanGoal(long).length).toBeLessThanOrEqual(100);
    });
  });
});
