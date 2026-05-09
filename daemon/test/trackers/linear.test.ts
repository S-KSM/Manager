import { describe, expect, it, vi } from 'vitest';
import { LinearTracker } from '../../src/trackers/linear.js';
import { TrackerError } from '../../src/trackers/index.js';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LinearTracker', () => {
  it('throws missing_tracker_api_key when no key', () => {
    expect(() => new LinearTracker({ apiKey: '', projectSlug: 'p' })).toThrow(TrackerError);
  });

  it('throws missing_tracker_project_slug when no slug', () => {
    expect(() => new LinearTracker({ apiKey: 'k', projectSlug: '' })).toThrow(TrackerError);
  });

  it('fetchCandidateIssues normalizes nodes + paginates', async () => {
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResp({
          data: {
            issues: {
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
              nodes: [
                {
                  id: 'i1',
                  identifier: 'ENG-1',
                  title: 'first',
                  description: 'd1',
                  priority: 2,
                  url: 'https://x/1',
                  branchName: 'eng-1',
                  createdAt: '2026-05-01T00:00:00Z',
                  updatedAt: null,
                  labels: { nodes: [{ name: 'Bug' }] },
                  state: { name: 'Todo' },
                  inverseRelations: {
                    nodes: [{ issue: { id: 'b1', identifier: 'ENG-9', state: { name: 'Done' } } }],
                  },
                },
              ],
            },
          },
        });
      }
      return jsonResp({
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: 'c2' },
            nodes: [
              {
                id: 'i2',
                identifier: 'ENG-2',
                title: 'second',
                priority: null,
                state: { name: 'In Progress' },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
          },
        },
      });
    });

    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tracker.fetchCandidateIssues(['Todo', 'In Progress']);
    expect(out.map((i) => i.identifier)).toEqual(['ENG-1', 'ENG-2']);
    expect(out[0]?.priority).toBe(2);
    expect(out[0]?.labels).toEqual(['bug']);
    expect(out[0]?.blocked_by).toEqual([{ id: 'b1', identifier: 'ENG-9', state: 'Done' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('linear_graphql_errors when GraphQL errors present', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResp({ data: null, errors: [{ message: 'no permission' }] }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.fetchCandidateIssues(['Todo'])).rejects.toMatchObject({
      code: 'linear_graphql_errors',
    });
  });

  it('linear_api_status on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.fetchCandidateIssues(['Todo'])).rejects.toMatchObject({
      code: 'linear_api_status',
    });
  });

  it('fetchIssueByIdentifier returns the issue when nodes has 1', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        data: {
          issues: {
            nodes: [
              {
                id: 'i9',
                identifier: 'ENG-123',
                title: 'Hello',
                description: null,
                priority: 1,
                url: 'https://x/9',
                state: { name: 'Todo' },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
          },
        },
      }),
    );
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const issue = await tracker.fetchIssueByIdentifier('ENG-123');
    expect(issue).not.toBeNull();
    expect(issue?.identifier).toBe('ENG-123');
    expect(issue?.id).toBe('i9');
    expect(issue?.state).toBe('Todo');
  });

  it('fetchIssueByIdentifier returns null when nodes is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ data: { issues: { nodes: [] } } }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const issue = await tracker.fetchIssueByIdentifier('NOPE-999');
    expect(issue).toBeNull();
  });

  it('addIssueComment posts the right mutation body and returns the comment id', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      capturedBody = typeof init.body === 'string' ? init.body : undefined;
      return jsonResp({
        data: { commentCreate: { success: true, comment: { id: 'c_1' } } },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tracker.addIssueComment('iss_1', 'Body **md**');
    expect(out.id).toBe('c_1');
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody as string) as {
      query: string;
      variables: { issueId: string; body: string };
    };
    expect(parsed.query).toContain('commentCreate');
    expect(parsed.variables.issueId).toBe('iss_1');
    expect(parsed.variables.body).toBe('Body **md**');
  });

  it('addIssueComment surfaces graphql errors as linear_graphql_errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResp({ data: null, errors: [{ message: 'no permission' }] }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.addIssueComment('iss_1', 'body')).rejects.toMatchObject({
      code: 'linear_graphql_errors',
    });
  });

  it('addIssueComment maps success=false to linear_comment_failed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResp({ data: { commentCreate: { success: false, comment: null } } }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.addIssueComment('iss_1', 'body')).rejects.toMatchObject({
      code: 'linear_comment_failed',
    });
  });

  it('setIssueState passes the id+stateId variables and accepts success=true', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      capturedBody = typeof init.body === 'string' ? init.body : undefined;
      return jsonResp({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: 'iss_1', state: { id: 's_done', name: 'Done' } },
          },
        },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.setIssueState('iss_1', 's_done');
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody as string) as {
      query: string;
      variables: { issueId: string; stateId: string };
    };
    expect(parsed.query).toContain('issueUpdate');
    expect(parsed.variables.issueId).toBe('iss_1');
    expect(parsed.variables.stateId).toBe('s_done');
  });

  it('setIssueState maps success=false to linear_state_not_found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResp({ data: { issueUpdate: { success: false, issue: null } } }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.setIssueState('iss_1', 's_bogus')).rejects.toMatchObject({
      code: 'linear_state_not_found',
    });
  });

  it('fetchIssueStatesByIds returns map keyed by issue.id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        data: {
          issues: {
            nodes: [
              { id: 'a', state: { name: 'In Progress' } },
              { id: 'b', state: { name: 'Done' } },
            ],
          },
        },
      }),
    );
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tracker.fetchIssueStatesByIds(['a', 'b']);
    expect(out.get('a')).toBe('In Progress');
    expect(out.get('b')).toBe('Done');
  });

  // ---- v1.4.7 write ops ----------------------------------------------------

  it('selfUserId resolves viewer.id once and caches across calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ data: { viewer: { id: 'u_self' } } }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await tracker.selfUserId()).toBe('u_self');
    expect(await tracker.selfUserId()).toBe('u_self');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('selfUserId throws linear_self_user_failed when viewer is null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ data: { viewer: null } }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.selfUserId()).rejects.toMatchObject({
      code: 'linear_self_user_failed',
    });
  });

  it('claimIssue assigns to viewer + writes issueUpdate when issue unassigned', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      calls.push(body);
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      if (body.query.includes('IssueAssignee')) {
        return jsonResp({ data: { issue: { id: 'iss_1', assignee: null, state: null } } });
      }
      // UpdateIssue mutation
      return jsonResp({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: 'iss_1', assignee: { id: 'u_self' }, state: null },
          },
        },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.claimIssue('iss_1', { stateId: 's_in_progress' });
    expect(calls).toHaveLength(3);
    const updateCall = calls.find((c) => c.query.includes('UpdateIssue'));
    expect(updateCall?.variables).toMatchObject({
      issueId: 'iss_1',
      input: { assigneeId: 'u_self', stateId: 's_in_progress' },
    });
  });

  it('claimIssue throws linear_assignee_taken when someone else holds the ticket', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      if (body.query.includes('IssueAssignee')) {
        return jsonResp({
          data: { issue: { id: 'iss_1', assignee: { id: 'u_other' }, state: null } },
        });
      }
      throw new Error('UpdateIssue should not be called when claim collides');
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(tracker.claimIssue('iss_1', {})).rejects.toMatchObject({
      code: 'linear_assignee_taken',
    });
  });

  it('releaseIssue clears assignee by writing assigneeId: null', async () => {
    let updateInput: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('UpdateIssue')) {
        updateInput = body.variables.input;
        return jsonResp({
          data: {
            issueUpdate: { success: true, issue: { id: 'iss_1', assignee: null, state: null } },
          },
        });
      }
      return jsonResp({ data: {} });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.releaseIssue('iss_1');
    expect(updateInput).toEqual({ assigneeId: null });
  });

  it('fetchCandidateIssues with assigneeFilter=unassigned inlines the null clause', async () => {
    let capturedQuery = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      capturedQuery = body.query;
      return jsonResp({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: 'c0' }, nodes: [] } },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.fetchCandidateIssues(['Todo'], { assigneeFilter: 'unassigned' });
    expect(capturedQuery).toContain('assignee: { null: { eq: true } }');
  });

  // ---- v1.4.10.1 state-name resolver --------------------------------------

  it('resolveStateIdByName caches the project-team state map across calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        data: {
          issues: {
            nodes: [
              {
                team: {
                  id: 't1',
                  states: {
                    nodes: [
                      { id: 's_todo', name: 'Todo' },
                      { id: 's_inp', name: 'In Progress' },
                      { id: 's_done', name: 'Done' },
                    ],
                  },
                },
              },
            ],
          },
        },
      }),
    );
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await tracker.resolveStateIdByName('In Progress')).toBe('s_inp');
    // Case-insensitive on the second call; cache hits — no second fetch.
    expect(await tracker.resolveStateIdByName('done')).toBe('s_done');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolveStateIdByName returns null when the project has no issues yet (empty nodes)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ data: { issues: { nodes: [] } } }));
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await tracker.resolveStateIdByName('In Progress')).toBeNull();
  });

  it('resolveStateIdByName returns null for a name that does not exist', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        data: {
          issues: {
            nodes: [{ team: { id: 't1', states: { nodes: [{ id: 's_todo', name: 'Todo' }] } } }],
          },
        },
      }),
    );
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await tracker.resolveStateIdByName('Nonsense')).toBeNull();
  });

  it('claimIssue with stateId writes both assigneeId and stateId in one mutation', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      calls.push(body);
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      if (body.query.includes('IssueAssignee')) {
        return jsonResp({ data: { issue: { id: 'iss_1', assignee: null, state: null } } });
      }
      return jsonResp({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: 'iss_1',
              assignee: { id: 'u_self' },
              state: { id: 's_inp', name: 'In Progress' },
            },
          },
        },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.claimIssue('iss_1', { stateId: 's_inp' });
    const updateCall = calls.find((c) => c.query.includes('UpdateIssue'));
    expect(updateCall?.variables).toMatchObject({
      issueId: 'iss_1',
      input: { assigneeId: 'u_self', stateId: 's_inp' },
    });
  });

  it('fetchCandidateIssues with assigneeFilter=self resolves viewer + inlines id', async () => {
    let capturedQuery = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      capturedQuery = body.query;
      return jsonResp({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: 'c0' }, nodes: [] } },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.fetchCandidateIssues(['Todo'], { assigneeFilter: 'self' });
    expect(capturedQuery).toContain('assignee: { id: { eq: "u_self" } }');
  });

  // ---- v1.4.10.4 multi-team resolveStateIdByName --------------------------

  it('resolveStateIdByName({teamId}) queries the team scope + caches per-team', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      calls.push(body);
      // TeamStates query — different state ids depending on team.
      if (body.query.includes('TeamStates')) {
        const teamId = body.variables.teamId as string;
        return jsonResp({
          data: {
            team: {
              id: teamId,
              states: {
                nodes:
                  teamId === 'team-a'
                    ? [{ id: 's_a_inp', name: 'In Progress' }]
                    : [{ id: 's_b_inp', name: 'In Progress' }],
              },
            },
          },
        });
      }
      throw new Error(`unexpected query: ${body.query.slice(0, 60)}`);
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await tracker.resolveStateIdByName('In Progress', { teamId: 'team-a' })).toBe('s_a_inp');
    expect(await tracker.resolveStateIdByName('In Progress', { teamId: 'team-b' })).toBe('s_b_inp');
    // Cache hit on second per-team call — no new fetch.
    expect(await tracker.resolveStateIdByName('in progress', { teamId: 'team-a' })).toBe('s_a_inp');
    expect(calls).toHaveLength(2);
  });

  it('claimIssue prefers stateName resolved against the issue team over pre-resolved stateId', async () => {
    let updateInput: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      if (body.query.includes('IssueAssignee')) {
        return jsonResp({
          data: {
            issue: { id: 'iss_b', assignee: null, state: null, team: { id: 'team-b' } },
          },
        });
      }
      if (body.query.includes('TeamStates')) {
        return jsonResp({
          data: {
            team: { id: 'team-b', states: { nodes: [{ id: 's_b_inp', name: 'In Progress' }] } },
          },
        });
      }
      // UpdateIssue
      updateInput = body.variables.input;
      return jsonResp({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: 'iss_b', assignee: { id: 'u_self' }, state: null },
          },
        },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Caller passes BOTH a fallback id (resolved against project-primary team A
    // at boot) AND the raw name. The team-aware path should win for team B.
    await tracker.claimIssue('iss_b', { stateId: 's_a_inp', stateName: 'In Progress' });
    expect(updateInput).toMatchObject({ assigneeId: 'u_self', stateId: 's_b_inp' });
  });

  it('claimIssue stateName miss falls back to caller-supplied stateId', async () => {
    let updateInput: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      if (body.query.includes('IssueAssignee')) {
        return jsonResp({
          data: {
            issue: { id: 'iss_c', assignee: null, state: null, team: { id: 'team-c' } },
          },
        });
      }
      if (body.query.includes('TeamStates')) {
        // Team C does NOT have a state by that name.
        return jsonResp({
          data: { team: { id: 'team-c', states: { nodes: [{ id: 's_c_todo', name: 'Todo' }] } } },
        });
      }
      updateInput = body.variables.input;
      return jsonResp({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: 'iss_c', assignee: { id: 'u_self' }, state: null },
          },
        },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.claimIssue('iss_c', { stateId: 's_fallback', stateName: 'In Progress' });
    expect(updateInput).toMatchObject({ stateId: 's_fallback' });
  });

  // ---- v1.4.10.5 stale-claim sweep query ----------------------------------

  it('fetchStaleSelfClaimedIssues sends self id + iso cutoff + active states', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      captured = body;
      return jsonResp({
        data: {
          issues: {
            nodes: [
              {
                id: 'i1',
                identifier: 'ENG-1',
                title: 'stale',
                state: { name: 'In Progress' },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
          },
        },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tracker.fetchStaleSelfClaimedIssues(['Todo', 'In Progress'], 60_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.identifier).toBe('ENG-1');
    expect(captured?.variables.selfId).toBe('u_self');
    expect(captured?.variables.states).toEqual(['Todo', 'In Progress']);
    // Cutoff is an ISO string roughly now-ttl.
    const cutoff = captured?.variables.updatedBefore as string;
    expect(typeof cutoff).toBe('string');
    expect(new Date(cutoff).getTime()).toBeLessThanOrEqual(Date.now() - 60_000 + 100);
  });

  it('fetchStaleSelfClaimedIssues returns empty array when ttlMs <= 0 (no round-trip)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => {
      throw new Error('should not be called');
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await tracker.fetchStaleSelfClaimedIssues(['Todo'], 0)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetchCandidateIssues with assigneeFilter=unassigned_or_self builds the OR clause', async () => {
    let capturedQuery = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.query.includes('Viewer')) {
        return jsonResp({ data: { viewer: { id: 'u_self' } } });
      }
      capturedQuery = body.query;
      return jsonResp({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: 'c0' }, nodes: [] } },
      });
    });
    const tracker = new LinearTracker({
      apiKey: 'k',
      projectSlug: 'proj',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await tracker.fetchCandidateIssues(['Todo'], { assigneeFilter: 'unassigned_or_self' });
    expect(capturedQuery).toContain('assignee: { null: { eq: true } }');
    expect(capturedQuery).toContain('assignee: { id: { eq: "u_self" } }');
    expect(capturedQuery).toContain('or:');
  });
});
