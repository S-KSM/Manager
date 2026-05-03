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
                    nodes: [
                      { issue: { id: 'b1', identifier: 'ENG-9', state: { name: 'Done' } } },
                    ],
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
    expect(out[0]?.blocked_by).toEqual([
      { id: 'b1', identifier: 'ENG-9', state: 'Done' },
    ]);
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
});
