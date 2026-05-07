import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterventionQueue } from '../src/intervention-queue.js';

describe('InterventionQueue', () => {
  let dir: string;
  let queue: InterventionQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-iq-'));
    queue = new InterventionQueue(join(dir, 'db.sqlite'));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueue → listPending sees it; ackDelivered empties pending', () => {
    const intv = queue.enqueue('demo', 'nudge', { message: 'hello' });
    expect(intv.id).toMatch(/^int_/);
    expect(intv.workstream_id).toBe('demo');
    expect(intv.kind).toBe('nudge');
    expect(intv.payload.message).toBe('hello');
    expect(intv.delivered_at).toBeNull();

    const pending = queue.listPending('demo');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(intv.id);

    const acked = queue.ackDelivered([intv.id]);
    expect(acked).toHaveLength(1);
    expect(acked[0]!.delivered_at).not.toBeNull();

    expect(queue.listPending('demo')).toHaveLength(0);
  });

  it('decideApproval merges decision + marks delivered (only for approval_required)', () => {
    const intv = queue.enqueue('demo', 'approval_required', {
      approval_request: { summary: 'rm -rf old/' },
    });
    const updated = queue.decideApproval(intv.id, true);
    expect(updated).not.toBeNull();
    expect(updated!.delivered_at).not.toBeNull();
    expect(updated!.payload.approval_decision?.approved).toBe(true);
    expect(updated!.payload.approval_request?.summary).toBe('rm -rf old/');
    // Second call returns null (already delivered).
    expect(queue.decideApproval(intv.id, false)).toBeNull();
    // Wrong kind returns null.
    const nudge = queue.enqueue('demo', 'nudge', { message: 'hi' });
    expect(queue.decideApproval(nudge.id, true)).toBeNull();
  });

  it('preserves enqueue order in listPending', async () => {
    const a = queue.enqueue('demo', 'nudge', { message: 'first' });
    // Avoid identical-millisecond timestamps for ordering check.
    await new Promise((r) => setTimeout(r, 5));
    const b = queue.enqueue('demo', 'redirect', { message: 'second' });

    const pending = queue.listPending('demo');
    expect(pending.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('ackDelivered is idempotent and skips missing/already-delivered ids', () => {
    const intv = queue.enqueue('demo', 'nudge', { message: 'hi' });

    const first = queue.ackDelivered([intv.id, 'int_missing']);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe(intv.id);

    // Second call is a no-op (already delivered).
    const second = queue.ackDelivered([intv.id]);
    expect(second).toHaveLength(0);

    // Pending list is empty either way.
    expect(queue.listPending('demo')).toHaveLength(0);
  });

  it('rollback payload round-trips with rollback_to_decision_id snake_case', () => {
    const intv = queue.enqueue('demo', 'rollback', {
      message: 'reconsider',
      rollback_to_decision_id: 'dec_07',
    });
    expect(intv.kind).toBe('rollback');
    expect(intv.payload.rollback_to_decision_id).toBe('dec_07');
    expect(intv.payload.message).toBe('reconsider');

    // Round-trip via listPending too (re-reads from DB).
    const [readBack] = queue.listPending('demo');
    expect(readBack?.payload.rollback_to_decision_id).toBe('dec_07');
    expect(readBack?.payload.message).toBe('reconsider');
  });

  it('listPending only returns rows for the matching workstream', () => {
    queue.enqueue('a', 'nudge', { message: 'for a' });
    queue.enqueue('b', 'nudge', { message: 'for b' });
    const pendingA = queue.listPending('a');
    expect(pendingA).toHaveLength(1);
    expect(pendingA[0]!.payload.message).toBe('for a');
  });

  it('answerQuestion records answer + marks delivered (question_required only)', () => {
    const intv = queue.enqueue('demo', 'question_required', {
      question_request: {
        question: 'Use cache?',
        options: ['yes', 'no'],
      },
    });
    const updated = queue.answerQuestion(intv.id, { choice: 'yes' });
    expect(updated).not.toBeNull();
    expect(updated!.delivered_at).not.toBeNull();
    expect(updated!.payload.question_answer?.choice).toBe('yes');
    // Original request preserved.
    expect(updated!.payload.question_request?.question).toBe('Use cache?');
    // Idempotency — second call returns null.
    expect(queue.answerQuestion(intv.id, { choice: 'no' })).toBeNull();
    // Wrong kind returns null.
    const nudge = queue.enqueue('demo', 'nudge', { message: 'hi' });
    expect(queue.answerQuestion(nudge.id, { choice: 'x' })).toBeNull();
  });

  it('answerQuestion accepts freetext-only answers', () => {
    const intv = queue.enqueue('demo', 'question_required', {
      question_request: { question: 'Why?', allow_freetext: true },
    });
    const updated = queue.answerQuestion(intv.id, { freetext: 'because' });
    expect(updated!.payload.question_answer?.freetext).toBe('because');
    expect(updated!.payload.question_answer?.choice).toBeUndefined();
  });

  it('get returns one row by id, null when missing', () => {
    const intv = queue.enqueue('demo', 'nudge', { message: 'one' });
    const fetched = queue.get(intv.id);
    expect(fetched?.id).toBe(intv.id);
    expect(queue.get('int_missing')).toBeNull();
  });

  it('migrates legacy DBs that still carry the v1.4.0 CHECK(kind IN …) constraint', () => {
    // Hand-built DB shaped like the pre-v1.4.4 schema. Survives across daemon
    // upgrades on real machines, so the migration must rebuild the table.
    const legacyDir = mkdtempSync(join(tmpdir(), 'manager-iq-legacy-'));
    const legacyPath = join(legacyDir, 'db.sqlite');
    const raw = new Database(legacyPath);
    raw.exec(`
      CREATE TABLE interventions (
        id            TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK(kind IN ('nudge','redirect','rollback')),
        payload_json  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        delivered_at  TEXT
      );
    `);
    raw.prepare(
      "INSERT INTO interventions VALUES ('int_legacy','ws','nudge','{\"message\":\"hi\"}','2026-05-07T00:00:00Z',NULL)",
    ).run();
    raw.close();

    const upgraded = new InterventionQueue(legacyPath);
    try {
      // The legacy row survives the rebuild.
      const all = upgraded.all('ws');
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe('int_legacy');
      // And the CHECK is gone — `approval_required` and `question_required`
      // both insert successfully now.
      expect(() =>
        upgraded.enqueue('ws', 'approval_required', { approval_request: { summary: 's' } }),
      ).not.toThrow();
      expect(() =>
        upgraded.enqueue('ws', 'question_required', {
          question_request: { question: 'q', allow_freetext: true },
        }),
      ).not.toThrow();
    } finally {
      upgraded.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
