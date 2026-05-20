import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore, type ManagerEvent } from '../src/event-store.js';
import { HandbookStore } from '../src/handbook-store.js';
import {
  type LLMGenerateArgs,
  type LLMProvider,
  type LLMProviderName,
  LLMUnreachableError,
} from '../src/llm/index.js';
import {
  SkillDistiller,
  buildDigest,
  groupBySession,
  meetsThreshold,
  parseHandbookTitles,
  parseLLMResponse,
} from '../src/skill-distiller.js';
import { SkillProposalsStore } from '../src/skill-proposals.js';
import { WorkstreamRegistry } from '../src/workstream.js';

function fakeProvider(impl: (args: LLMGenerateArgs) => Promise<string>): LLMProvider {
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

function session(
  workstreamId: string,
  sessionId: string,
  body: ManagerEvent[],
  opts: { end?: boolean } = {},
): ManagerEvent[] {
  const start = ev({ workstream_id: workstreamId, session_id: sessionId, type: 'session_start' });
  const inner = body.map((e) => ({ ...e, session_id: sessionId }));
  if (opts.end === false) return [start, ...inner];
  const end = ev({ workstream_id: workstreamId, session_id: sessionId, type: 'session_end' });
  return [start, ...inner, end];
}

function decision(ws: string, choice: string, rationale = 'because'): ManagerEvent {
  return ev({
    workstream_id: ws,
    type: 'decision',
    payload: { choice, rationale, confidence: 0.7 },
  });
}

function subgoal(ws: string, goal: string): ManagerEvent {
  return ev({ workstream_id: ws, type: 'subgoal_push', payload: { goal } });
}

describe('SkillDistiller helpers', () => {
  describe('parseLLMResponse', () => {
    it('parses bare JSON', () => {
      expect(parseLLMResponse('{"propose":false}')).toEqual({ propose: false });
    });
    it('parses fenced JSON', () => {
      const r = parseLLMResponse('```json\n{"propose":true,"title":"X","body":"Y"}\n```');
      expect(r).toEqual({ propose: true, title: 'X', body: 'Y' });
    });
    it('extracts JSON from a preamble', () => {
      const r = parseLLMResponse('Here you go: {"propose": false} ok.');
      expect(r).toEqual({ propose: false });
    });
    it('returns null on garbage', () => {
      expect(parseLLMResponse('lol')).toBeNull();
    });
    it('returns null when propose is missing or wrong type', () => {
      expect(parseLLMResponse('{"title":"X"}')).toBeNull();
      expect(parseLLMResponse('{"propose":"yes"}')).toBeNull();
    });
  });

  describe('parseHandbookTitles', () => {
    it('extracts H2s, lowercased', () => {
      const md =
        '# Team handbook\n\n## Cache-busting in CI\n\nfoo\n\n## Avoid Mocks in Migrations\n\nbar';
      const titles = parseHandbookTitles(md);
      expect(titles.has('cache-busting in ci')).toBe(true);
      expect(titles.has('avoid mocks in migrations')).toBe(true);
      expect(titles.has('team handbook')).toBe(false); // H1 ignored
    });
    it('returns empty set on empty input', () => {
      expect(parseHandbookTitles('').size).toBe(0);
    });
  });

  describe('groupBySession + threshold + digest', () => {
    it('groups events by session_id and flags ended', () => {
      const events = [
        ...session('w', 's1', [decision('w', 'A')]),
        ...session('w', 's2', [subgoal('w', 'open')], { end: false }),
      ];
      const sessions = groupBySession(events);
      const s1 = sessions.find((x) => x.sessionId === 's1')!;
      const s2 = sessions.find((x) => x.sessionId === 's2')!;
      expect(s1.ended).toBe(true);
      expect(s2.ended).toBe(false);
      expect(s1.decisions).toHaveLength(1);
      expect(s2.subgoals).toHaveLength(1);
    });

    it('meetsThreshold: ≥1 decision OR ≥3 subgoals', () => {
      const events = [...session('w', 's1', [decision('w', 'A')])];
      const s = groupBySession(events)[0]!;
      expect(meetsThreshold(s, 1, 3)).toBe(true);

      const noisy = [
        ...session('w', 's2', [subgoal('w', 'a'), subgoal('w', 'b'), subgoal('w', 'c')]),
      ];
      const s2 = groupBySession(noisy)[0]!;
      expect(meetsThreshold(s2, 1, 3)).toBe(true);

      const thin = [...session('w', 's3', [subgoal('w', 'a')])];
      const s3 = groupBySession(thin)[0]!;
      expect(meetsThreshold(s3, 1, 3)).toBe(false);
    });

    it('buildDigest includes decisions and subgoals', () => {
      const evs = [
        ...session('w', 's1', [
          decision('w', 'use SWR', 'lower latency'),
          subgoal('w', 'wire SWR client'),
        ]),
      ];
      const s = groupBySession(evs)[0]!;
      const digest = buildDigest(s);
      expect(digest).toContain('use SWR');
      expect(digest).toContain('lower latency');
      expect(digest).toContain('wire SWR client');
    });
  });
});

describe('SkillDistiller', () => {
  let tmpDir: string;
  let registry: WorkstreamRegistry;
  let eventStore: EventStore;
  let handbookStore: HandbookStore;
  let proposals: SkillProposalsStore;
  let dbPath: string;

  beforeEach(async () => {
    counter = 0;
    tmpDir = await mkdtemp(join(tmpdir(), 'distill-'));
    dbPath = join(tmpDir, 'db.sqlite');
    registry = new WorkstreamRegistry(dbPath);
    eventStore = new EventStore(join(tmpDir, 'events'));
    handbookStore = new HandbookStore(join(tmpDir, 'handbook.md'));
    proposals = new SkillProposalsStore(dbPath);
  });

  afterEach(async () => {
    registry.close();
    proposals.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function buildDistiller(generate: (args: LLMGenerateArgs) => Promise<string>): SkillDistiller {
    return new SkillDistiller({
      registry,
      eventStore,
      handbookStore,
      skillProposalsStore: proposals,
      getProvider: () => fakeProvider(generate),
      dbPath,
    });
  }

  it('skips sessions without session_end', async () => {
    const ws = 'feat-a';
    registry.create(ws, 'Feature A');
    for (const e of session(ws, 's1', [decision(ws, 'A')], { end: false })) {
      await eventStore.appendEvent(ws, e);
    }
    let calls = 0;
    const d = buildDistiller(async () => {
      calls += 1;
      return '{"propose":false}';
    });
    await d.tick();
    expect(calls).toBe(0);
    expect(proposals.listProposed()).toHaveLength(0);
  });

  it('skips sessions below threshold but marks them seen', async () => {
    const ws = 'feat-b';
    registry.create(ws, 'Feature B');
    for (const e of session(ws, 's1', [subgoal(ws, 'one')])) {
      await eventStore.appendEvent(ws, e);
    }
    let calls = 0;
    const d = buildDistiller(async () => {
      calls += 1;
      return '{"propose":false}';
    });
    await d.tick();
    await d.tick(); // second tick must not re-call LLM
    expect(calls).toBe(0);
    expect(proposals.listProposed()).toHaveLength(0);
  });

  it('propose=false marks seen, no proposal', async () => {
    const ws = 'feat-c';
    registry.create(ws, 'Feature C');
    for (const e of session(ws, 's1', [decision(ws, 'A')])) {
      await eventStore.appendEvent(ws, e);
    }
    let calls = 0;
    const d = buildDistiller(async () => {
      calls += 1;
      return '{"propose":false}';
    });
    await d.tick();
    await d.tick();
    expect(calls).toBe(1); // second tick saw "seen", didn't re-call
    expect(proposals.listProposed()).toHaveLength(0);
  });

  it('propose=true writes proposal + skill_proposed event + marks seen', async () => {
    const ws = 'feat-d';
    registry.create(ws, 'Feature D');
    for (const e of session(ws, 's1', [decision(ws, 'use SWR', 'lower latency')])) {
      await eventStore.appendEvent(ws, e);
    }
    const d = buildDistiller(
      async () =>
        '{"propose":true,"title":"Prefer SWR for live data","body":"Use SWR when staleness budget is < 5s."}',
    );
    await d.tick();

    const list = proposals.listProposed();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('Prefer SWR for live data');
    expect(list[0]!.workstream_id).toBe(ws);
    expect(list[0]!.source_decision_id).toBeTruthy();

    const { events } = await eventStore.readEvents(ws);
    const sp = events.find((e) => e.type === 'skill_proposed');
    expect(sp).toBeDefined();
    expect(sp!.payload!['source']).toBe('skill_distiller');
    expect(sp!.payload!['proposal_id']).toBe(list[0]!.id);

    await d.tick(); // idempotent
    expect(proposals.listProposed()).toHaveLength(1);
  });

  it('drops duplicate title vs existing handbook H2 (case-insensitive)', async () => {
    const ws = 'feat-e';
    registry.create(ws, 'Feature E');
    await writeFile(
      join(tmpDir, 'handbook.md'),
      '# Team handbook\n\n## Prefer SWR for live data\n\nbody\n',
      'utf8',
    );
    for (const e of session(ws, 's1', [decision(ws, 'use SWR')])) {
      await eventStore.appendEvent(ws, e);
    }
    const d = buildDistiller(
      async () => '{"propose":true,"title":"prefer SWR for live data","body":"different body"}',
    );
    await d.tick();
    expect(proposals.listProposed()).toHaveLength(0);
  });

  it('LLM unreachable does NOT mark seen (retries next tick)', async () => {
    const ws = 'feat-f';
    registry.create(ws, 'Feature F');
    for (const e of session(ws, 's1', [decision(ws, 'A')])) {
      await eventStore.appendEvent(ws, e);
    }
    let calls = 0;
    let throwOnce = true;
    const d = buildDistiller(async () => {
      calls += 1;
      if (throwOnce) {
        throwOnce = false;
        throw new LLMUnreachableError('boom');
      }
      return '{"propose":true,"title":"Retry pattern","body":"x"}';
    });
    await d.tick();
    expect(calls).toBe(1);
    expect(proposals.listProposed()).toHaveLength(0);
    await d.tick();
    expect(calls).toBe(2);
    expect(proposals.listProposed()).toHaveLength(1);
  });

  it('rejects oversize title / body as invalid_response and marks seen', async () => {
    const ws = 'feat-g';
    registry.create(ws, 'Feature G');
    for (const e of session(ws, 's1', [decision(ws, 'A')])) {
      await eventStore.appendEvent(ws, e);
    }
    let calls = 0;
    const huge = 'x'.repeat(90);
    const d = buildDistiller(async () => {
      calls += 1;
      return JSON.stringify({ propose: true, title: huge, body: 'fine' });
    });
    await d.tick();
    await d.tick();
    expect(calls).toBe(1); // second tick saw seen
    expect(proposals.listProposed()).toHaveLength(0);
  });

  it('skips retired workstreams', async () => {
    const ws = 'feat-h';
    registry.create(ws, 'Feature H');
    registry.setStatus(ws, 'retired');
    for (const e of session(ws, 's1', [decision(ws, 'A')])) {
      await eventStore.appendEvent(ws, e);
    }
    let calls = 0;
    const d = buildDistiller(async () => {
      calls += 1;
      return '{"propose":false}';
    });
    await d.tick();
    expect(calls).toBe(0);
  });
});
