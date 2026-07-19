import { describe, expect, it } from 'vitest';

import { buildDigestBody } from '../../src/passes/pass3/digest.js';
import type { DigestBrainCompleteRow } from '../../src/passes/pass3/types.js';

const TODAY = '2026-07-19' as never;
const NO_TASKS = { handled: 0, stale: 0, open: 0 };

function row(overrides: Partial<DigestBrainCompleteRow> = {}): DigestBrainCompleteRow {
  return { threadId: 'T1', actionRequired: 'NO_ACTION', slackMessage: '', ...overrides };
}

describe('buildDigestBody — valid (at least one surfaced block)', () => {
  it('produces a valid digest with numbered blocks from surfaced rows', () => {
    const result = buildDigestBody(
      [row({ threadId: 'T1', actionRequired: 'REPLY_NEEDED', slackMessage: '[1] Alice — Hello\nREPLY_NEEDED | summary' }), row({ threadId: 'T2' })],
      'RUN-1',
      TODAY,
      NO_TASKS,
    );
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.surfacedCount).toBe(1);
      expect(result.filteredCount).toBe(1);
      expect(result.body).toContain('Alice — Hello');
      expect(result.body).toContain('RUN-1');
      expect(result.body).toContain('2026-07-19');
    }
  });

  it('includes the Aida footer when there is at least one surfaced block', () => {
    const result = buildDigestBody([row({ slackMessage: '[1] x' })], 'RUN-1', TODAY, NO_TASKS);
    if (result.kind === 'valid') expect(result.body).toContain('Review in Aida');
  });

  it('includes the task reconciliation line', () => {
    const result = buildDigestBody([row({ slackMessage: '[1] x' })], 'RUN-1', TODAY, { handled: 2, stale: 1, open: 3 });
    if (result.kind === 'valid') {
      expect(result.body).toContain('2 likely handled');
      expect(result.body).toContain('1 likely stale');
      expect(result.body).toContain('3 still open');
    }
  });

  it('includes drift notes when provided', () => {
    const result = buildDigestBody([row({ slackMessage: '[1] x' })], 'RUN-1', TODAY, NO_TASKS, ['Alice — Attio bhc_contact_id mismatch']);
    if (result.kind === 'valid') expect(result.body).toContain('Attio bhc_contact_id mismatch');
  });

  it('omits the filtered tail line when nothing was filtered', () => {
    const result = buildDigestBody([row({ slackMessage: '[1] x' })], 'RUN-1', TODAY, NO_TASKS);
    if (result.kind === 'valid') expect(result.body).not.toContain('Filtered as noise/internal');
  });
});

describe('buildDigestBody — all_clear (zero actionable, not a failure)', () => {
  it('produces an all-clear message when every row was filtered', () => {
    const result = buildDigestBody([row(), row()], 'RUN-1', TODAY, NO_TASKS);
    expect(result.kind).toBe('all_clear');
    if (result.kind === 'all_clear') {
      expect(result.body).toContain('Nothing needs your attention tonight');
      expect(result.body).toContain('Filtered as noise/internal: 2 threads');
    }
  });

  it('produces an all-clear message when there were zero rows at all', () => {
    const result = buildDigestBody([], 'RUN-1', TODAY, NO_TASKS);
    expect(result.kind).toBe('all_clear');
  });

  it('still includes the task reconciliation line on an all-clear night', () => {
    const result = buildDigestBody([row()], 'RUN-1', TODAY, { handled: 1, stale: 0, open: 0 });
    if (result.kind === 'all_clear') expect(result.body).toContain('1 likely handled');
  });

  it('uses singular "thread" for exactly one filtered row, not "threads"', () => {
    const result = buildDigestBody([row()], 'RUN-1', TODAY, NO_TASKS);
    if (result.kind === 'all_clear') {
      expect(result.body).toContain('Filtered as noise/internal: 1 thread');
      expect(result.body).not.toContain('1 threads');
    }
  });
});
