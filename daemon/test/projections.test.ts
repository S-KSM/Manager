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
      todos: null,
      latest_activity: null,
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

  describe('todos (Feature B — TodoWrite mirror)', () => {
    it('one TodoWrite call → todos reflects parsed array', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: {
            hook: 'post-tool-use',
            tool_name: 'TodoWrite',
            tool_input: {
              todos: [
                { content: 'Read the spec', status: 'completed', activeForm: 'Reading the spec' },
                {
                  content: 'Implement projection',
                  status: 'in_progress',
                  activeForm: 'Implementing projection',
                },
                { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
              ],
            },
          },
        }),
      ];
      const result = projectFromEvents(events);
      expect(result.todos).not.toBeNull();
      expect(result.todos).toHaveLength(3);
      expect(result.todos?.[0]).toEqual({
        content: 'Read the spec',
        status: 'completed',
        activeForm: 'Reading the spec',
      });
      expect(result.todos?.[1]?.status).toBe('in_progress');
    });

    it('two TodoWrite calls → todos reflects only the latest (last write wins)', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: {
            hook: 'post-tool-use',
            tool_name: 'TodoWrite',
            tool_input: {
              todos: [{ content: 'Step 1 (old)', status: 'in_progress' }],
            },
          },
        }),
        ev('tool_use', '2026-05-02T10:05:00Z', {
          id: 'tu_2',
          payload: {
            hook: 'post-tool-use',
            tool_name: 'TodoWrite',
            tool_input: {
              todos: [
                { content: 'Step 1 (done)', status: 'completed' },
                { content: 'Step 2 (now)', status: 'in_progress' },
              ],
            },
          },
        }),
      ];
      const result = projectFromEvents(events);
      expect(result.todos).toHaveLength(2);
      expect(result.todos?.[0]?.content).toBe('Step 1 (done)');
      expect(result.todos?.[1]?.content).toBe('Step 2 (now)');
    });

    it('no TodoWrite but other tool_use events → todos null, latest_activity humanized', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: {
            hook: 'pre-tool-use',
            tool_name: 'Read',
            tool_input: { file_path: '/Users/shobeir/Code/foo/bar.ts' },
          },
        }),
        ev('tool_use', '2026-05-02T10:01:00Z', {
          id: 'tu_2',
          payload: {
            hook: 'pre-tool-use',
            tool_name: 'Bash',
            tool_input: { command: 'npm test -- --run' },
          },
        }),
        ev('tool_use', '2026-05-02T10:02:00Z', {
          id: 'tu_3',
          payload: {
            hook: 'pre-tool-use',
            tool_name: 'Edit',
            tool_input: { file_path: 'src/projections.ts' },
          },
        }),
      ];
      const result = projectFromEvents(events);
      expect(result.todos).toBeNull();
      expect(result.latest_activity).toBe('Editing src/projections.ts');
    });

    it('humanizes Bash with cmd truncated to 60 chars', () => {
      const longCmd = 'find . -name "*.ts" -not -path "*/node_modules/*" | xargs wc -l';
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: { tool_name: 'Bash', tool_input: { command: longCmd } },
        }),
      ];
      const result = projectFromEvents(events);
      // Running: + first 60 chars + truncation marker
      expect(result.latest_activity).toBe(`Running: ${longCmd.slice(0, 60)}…`);
    });

    it('humanizes Glob/Grep with pattern, WebFetch as "Browsing the web"', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: { tool_name: 'Glob', tool_input: { pattern: '**/*.swift' } },
        }),
      ];
      expect(projectFromEvents(events).latest_activity).toBe('Searching for **/*.swift');

      const webEvents: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_w',
          payload: { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
        }),
      ];
      expect(projectFromEvents(webEvents).latest_activity).toBe('Browsing the web');
    });

    it('truncates the activity line to 80 chars total', () => {
      const veryLongPath = `/very/long/path/${'a'.repeat(200)}.ts`;
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: { tool_name: 'Read', tool_input: { file_path: veryLongPath } },
        }),
      ];
      const result = projectFromEvents(events);
      expect(result.latest_activity?.length).toBe(80);
      expect(result.latest_activity?.endsWith('…')).toBe(true);
    });

    it('unknown tool falls back to "Using <tool>"', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: { tool_name: 'mcp__custom__do_thing', tool_input: { x: 1 } },
        }),
      ];
      expect(projectFromEvents(events).latest_activity).toBe('Using mcp__custom__do_thing');
    });

    it('TodoWrite with malformed items skips bad rows but keeps the rest', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: {
            tool_name: 'TodoWrite',
            tool_input: {
              todos: [
                { content: 'Good one', status: 'pending' },
                { content: 42, status: 'pending' }, // bad content type
                { content: 'No status' }, // missing status
                { content: 'Bad status', status: 'finished' }, // unknown status
                {
                  content: 'Active',
                  status: 'in_progress',
                  activeForm: 'Doing the thing',
                  extraKey: 'permitted', // extras tolerated
                },
              ],
            },
          },
        }),
      ];
      const result = projectFromEvents(events);
      expect(result.todos).toHaveLength(2);
      expect(result.todos?.map((t) => t.content)).toEqual(['Good one', 'Active']);
      expect(result.todos?.[1]?.activeForm).toBe('Doing the thing');
    });

    it('accepts payload.input.todos (Anthropic SDK shape) as a fallback', () => {
      const events: ManagerEvent[] = [
        ev('tool_use', '2026-05-02T10:00:00Z', {
          id: 'tu_1',
          payload: {
            tool_name: 'TodoWrite',
            input: {
              todos: [{ content: 'Via input field', status: 'pending' }],
            },
          },
        }),
      ];
      const result = projectFromEvents(events);
      expect(result.todos).toHaveLength(1);
      expect(result.todos?.[0]?.content).toBe('Via input field');
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
