import { describe, expect, it } from 'vitest';
import type { ManagerEvent } from '../src/event-store.js';
import { projectFromEvents } from '../src/projections.js';

function ev(
  type: ManagerEvent['type'],
  ts: string,
  extra: Partial<ManagerEvent> = {},
): ManagerEvent {
  return {
    ts,
    workstream_id: 'w',
    type,
    ...extra,
  };
}

describe('projectFromEvents', () => {
  it('returns nulls/false for empty event log', () => {
    expect(projectFromEvents([])).toEqual({
      current_subgoal: null,
      latest_confidence: null,
      needs_attention: false,
    });
  });

  describe('current_subgoal', () => {
    it('push A, push B, pop → head is A', () => {
      const events: ManagerEvent[] = [
        ev('subgoal_push', '2026-05-02T10:00:00Z', { id: '1', payload: { goal: 'A' } }),
        ev('subgoal_push', '2026-05-02T10:01:00Z', { id: '2', payload: { goal: 'B' } }),
        ev('subgoal_pop', '2026-05-02T10:02:00Z', { id: '3' }),
      ];
      expect(projectFromEvents(events).current_subgoal).toBe('A');
    });

    it('push X, pop, pop → null (over-popping is tolerated)', () => {
      const events: ManagerEvent[] = [
        ev('subgoal_push', '2026-05-02T10:00:00Z', { id: '1', payload: { goal: 'X' } }),
        ev('subgoal_pop', '2026-05-02T10:01:00Z', { id: '2' }),
        ev('subgoal_pop', '2026-05-02T10:02:00Z', { id: '3' }),
      ];
      expect(projectFromEvents(events).current_subgoal).toBeNull();
    });

    it('ignores subgoal_push with non-string goal', () => {
      const events: ManagerEvent[] = [
        ev('subgoal_push', '2026-05-02T10:00:00Z', { id: '1', payload: { goal: 'A' } }),
        ev('subgoal_push', '2026-05-02T10:01:00Z', {
          id: '2',
          payload: { goal: 42 as unknown as string },
        }),
      ];
      expect(projectFromEvents(events).current_subgoal).toBe('A');
    });
  });

  describe('latest_confidence', () => {
    it('decision then later confidence → returns confidence value', () => {
      const events: ManagerEvent[] = [
        ev('decision', '2026-05-02T10:00:00Z', {
          id: 'dec_1',
          payload: { confidence: 0.8, choice: 'X', considered: ['X'], rationale: '' },
        }),
        ev('confidence', '2026-05-02T11:00:00Z', { id: 'c_1', payload: { value: 0.5 } }),
      ];
      expect(projectFromEvents(events).latest_confidence).toBe(0.5);
    });

    it('confidence then later decision → returns decision confidence', () => {
      const events: ManagerEvent[] = [
        ev('confidence', '2026-05-02T10:00:00Z', { id: 'c_1', payload: { value: 0.5 } }),
        ev('decision', '2026-05-02T11:00:00Z', {
          id: 'dec_1',
          payload: { confidence: 0.8, choice: 'X', considered: ['X'], rationale: '' },
        }),
      ];
      expect(projectFromEvents(events).latest_confidence).toBe(0.8);
    });

    it('no confidence/decision → null', () => {
      const events: ManagerEvent[] = [
        ev('subgoal_push', '2026-05-02T10:00:00Z', { id: '1', payload: { goal: 'A' } }),
      ];
      expect(projectFromEvents(events).latest_confidence).toBeNull();
    });

    it('ignores non-numeric confidence values', () => {
      const events: ManagerEvent[] = [
        ev('confidence', '2026-05-02T10:00:00Z', {
          id: 'c_1',
          payload: { value: 'high' as unknown as number },
        }),
        ev('decision', '2026-05-02T11:00:00Z', {
          id: 'dec_1',
          payload: { confidence: null as unknown as number, choice: 'X' },
        }),
      ];
      expect(projectFromEvents(events).latest_confidence).toBeNull();
    });

    it('ignores NaN/Infinity', () => {
      const events: ManagerEvent[] = [
        ev('confidence', '2026-05-02T10:00:00Z', { id: 'c_1', payload: { value: Number.NaN } }),
        ev('confidence', '2026-05-02T11:00:00Z', { id: 'c_2', payload: { value: 0.42 } }),
      ];
      expect(projectFromEvents(events).latest_confidence).toBe(0.42);
    });
  });

  describe('needs_attention', () => {
    it('blocked for s1, no later session_end for s1 → true', () => {
      const events: ManagerEvent[] = [
        ev('blocked', '2026-05-02T10:00:00Z', {
          id: 'b_1',
          session_id: 's1',
          payload: { reason: 'stuck' },
        }),
      ];
      expect(projectFromEvents(events).needs_attention).toBe(true);
    });

    it('blocked then session_end for same session later → false', () => {
      const events: ManagerEvent[] = [
        ev('blocked', '2026-05-02T10:00:00Z', {
          id: 'b_1',
          session_id: 's1',
          payload: { reason: 'stuck' },
        }),
        ev('session_end', '2026-05-02T11:00:00Z', { id: 'se_1', session_id: 's1' }),
      ];
      expect(projectFromEvents(events).needs_attention).toBe(false);
    });

    it('blocked for s1 + session_end for s2 (different session) → still true', () => {
      const events: ManagerEvent[] = [
        ev('blocked', '2026-05-02T10:00:00Z', {
          id: 'b_1',
          session_id: 's1',
          payload: { reason: 'stuck' },
        }),
        ev('session_end', '2026-05-02T11:00:00Z', { id: 'se_1', session_id: 's2' }),
      ];
      expect(projectFromEvents(events).needs_attention).toBe(true);
    });

    it('blocked without session_id; later session_end (any) → false', () => {
      const events: ManagerEvent[] = [
        ev('blocked', '2026-05-02T10:00:00Z', { id: 'b_1', payload: { reason: 'stuck' } }),
        ev('session_end', '2026-05-02T11:00:00Z', { id: 'se_1', session_id: 'sx' }),
      ];
      expect(projectFromEvents(events).needs_attention).toBe(false);
    });

    it('no blocked event ever → false', () => {
      const events: ManagerEvent[] = [
        ev('session_start', '2026-05-02T09:00:00Z', { id: 'ss_1', session_id: 's1' }),
        ev('session_end', '2026-05-02T11:00:00Z', { id: 'se_1', session_id: 's1' }),
      ];
      expect(projectFromEvents(events).needs_attention).toBe(false);
    });
  });

  it('does not throw on malformed events', () => {
    const garbage = [
      null as unknown as ManagerEvent,
      { type: 'subgoal_push' } as ManagerEvent,
      {
        type: 'decision',
        payload: 'not-an-object' as unknown as Record<string, unknown>,
      } as ManagerEvent,
      ev('confidence', '2026-05-02T10:00:00Z', { id: 'ok', payload: { value: 0.3 } }),
    ];
    const result = projectFromEvents(garbage);
    expect(result.latest_confidence).toBe(0.3);
    expect(result.current_subgoal).toBeNull();
    expect(result.needs_attention).toBe(false);
  });
});
