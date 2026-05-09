import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflow, WorkflowError } from '../src/workflow-loader.js';

describe('loadWorkflow', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'workflow-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('parses front matter + prompt template', async () => {
    const path = join(tmp, 'WORKFLOW.md');
    await writeFile(
      path,
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  project_slug: my-project',
        '  api_key: $TEST_FAKE_KEY',
        'polling:',
        '  interval_ms: 5000',
        'workspace:',
        '  root: ./ws',
        'agent:',
        '  runtime: claude-code',
        '  max_concurrent_agents: 3',
        '---',
        'You are working on {{ issue.identifier }}.',
        '',
      ].join('\n'),
    );
    process.env['TEST_FAKE_KEY'] = 'lin_xxx';
    try {
      const wf = await loadWorkflow(path);
      expect(wf.config.tracker.kind).toBe('linear');
      expect(wf.config.tracker.project_slug).toBe('my-project');
      expect(wf.config.tracker.api_key).toBe('lin_xxx');
      expect(wf.config.polling.interval_ms).toBe(5000);
      expect(wf.config.workspace.root.endsWith('/ws')).toBe(true);
      expect(wf.config.agent.runtime).toBe('claude-code');
      expect(wf.config.agent.max_concurrent_agents).toBe(3);
      expect(wf.prompt_template).toBe('You are working on {{ issue.identifier }}.');
    } finally {
      delete process.env['TEST_FAKE_KEY'];
    }
  });

  it('treats missing $VAR as empty string for api_key', async () => {
    const path = join(tmp, 'WORKFLOW.md');
    await writeFile(
      path,
      ['---', 'tracker:', '  kind: linear', '  api_key: $NOT_SET', '---', ''].join('\n'),
    );
    const wf = await loadWorkflow(path);
    expect(wf.config.tracker.api_key).toBe('');
  });

  it('returns defaults when front matter is empty', async () => {
    const path = join(tmp, 'WORKFLOW.md');
    await writeFile(path, ['---', '---', 'just a prompt'].join('\n'));
    const wf = await loadWorkflow(path);
    expect(wf.config.polling.interval_ms).toBe(30000);
    expect(wf.config.agent.runtime).toBe('claude-code');
    expect(wf.config.tracker.active_states).toEqual(['Todo', 'In Progress']);
    expect(wf.prompt_template).toBe('just a prompt');
  });

  it('throws WorkflowError(missing_workflow_file) when path does not exist', async () => {
    await expect(loadWorkflow(join(tmp, 'no.md'))).rejects.toBeInstanceOf(WorkflowError);
  });

  it('throws WorkflowError(workflow_front_matter_not_a_map) when YAML is not a map', async () => {
    const path = join(tmp, 'WORKFLOW.md');
    await writeFile(path, ['---', '- not', '- a map', '---', ''].join('\n'));
    await expect(loadWorkflow(path)).rejects.toMatchObject({
      code: 'workflow_front_matter_not_a_map',
    });
  });

  it('treats file with no front matter as pure body', async () => {
    const path = join(tmp, 'WORKFLOW.md');
    await writeFile(path, 'no front matter, just text\n');
    const wf = await loadWorkflow(path);
    expect(wf.prompt_template).toBe('no front matter, just text');
  });

  it('claim_on_dispatch defaults false; flipping it on flips assign_to_self + unassigned_only', async () => {
    const a = join(tmp, 'A.md');
    await writeFile(a, ['---', 'tracker: { kind: linear }', '---', ''].join('\n'));
    const wfa = await loadWorkflow(a);
    expect(wfa.config.tracker.claim_on_dispatch).toBe(false);
    expect(wfa.config.tracker.assign_to_self).toBe(false);
    expect(wfa.config.tracker.unassigned_only).toBe(false);
    expect(wfa.config.tracker.claim_state).toBeNull();

    const b = join(tmp, 'B.md');
    await writeFile(
      b,
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  claim_on_dispatch: true',
        '  claim_state: In Progress',
        '---',
        '',
      ].join('\n'),
    );
    const wfb = await loadWorkflow(b);
    expect(wfb.config.tracker.claim_on_dispatch).toBe(true);
    expect(wfb.config.tracker.assign_to_self).toBe(true);
    expect(wfb.config.tracker.unassigned_only).toBe(true);
    expect(wfb.config.tracker.claim_state).toBe('In Progress');
  });
});
