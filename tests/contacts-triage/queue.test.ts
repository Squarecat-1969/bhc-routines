import { describe, expect, it } from 'vitest';

import { QUEUE_COLS, QUEUE_COLUMNS } from '../../src/config/triage-constants.js';
import {
  buildQueueRow,
  distributionOf,
  hasNewEvidence,
  mergeQueue,
  parseExistingQueueRow,
  serializeQueueRow,
  sortMerged,
} from '../../src/passes/contacts-triage/queue.js';
import { countByDomain, deriveSignals } from '../../src/passes/contacts-triage/signals.js';
import { scoreContact } from '../../src/passes/contacts-triage/score.js';
import { withStrength } from './fixtures.js';
import type { CivilDate } from '../../src/lib/dates.js';
import type {
  ExistingQueueRow,
  QueueColumn,
  ScoredContact,
  UnbridgedContact,
} from '../../src/passes/contacts-triage/types.js';

const TODAY = '2026-08-08' as CivilDate;
function scoredContact(id: string, overrides: Partial<UnbridgedContact> = {}): ScoredContact {
  const c = withStrength('Good', { attioRecordId: id, ...overrides });
  const signals = deriveSignals({ contact: c, domainCounts: countByDomain([c]) });
  const deterministic = scoreContact(signals);
  return {
    contact: c,
    signals,
    deterministic,
    llm: null,
    finalScore: deterministic.score,
    scoreSource: 'deterministic',
    clamped: false,
    column: deterministic.score >= 75 ? 'keepers' : deterministic.score <= 25 ? 'junk' : 'unclear',
    reason: deterministic.reason,
  };
}

/** An existing tab row, built from the same serializer the routine uses. */
function existingRow(
  id: string,
  overrides: Partial<{
    status: string;
    skipUntil: string;
    firstSeen: string;
    lastScored: string;
    keeperProbability: number;
    column: QueueColumn;
    reason: string;
  }> = {},
): ExistingQueueRow {
  const cells = serializeQueueRow(
    buildQueueRow(scoredContact(id), { today: TODAY, firstSeen: overrides.firstSeen ?? '2026-01-15', status: 'pending' }),
  );
  cells[QUEUE_COLS.status] = overrides.status ?? 'pending';
  cells[QUEUE_COLS.skipUntil] = overrides.skipUntil ?? '';
  cells[QUEUE_COLS.lastScored] = overrides.lastScored ?? '2026-06-01';
  cells[QUEUE_COLS.keeperProbability] = overrides.keeperProbability ?? 50;
  cells[QUEUE_COLS.column] = overrides.column ?? 'unclear';
  if (overrides.reason !== undefined) cells[QUEUE_COLS.reason] = overrides.reason;
  return parseExistingQueueRow(cells)!;
}

function merge(args: {
  scored?: ScoredContact[];
  existing?: ExistingQueueRow[];
  bridged?: string[];
  excluded?: string[];
}) {
  return mergeQueue({
    scored: args.scored ?? [],
    existing: args.existing ?? [],
    bridgedIds: new Set(args.bridged ?? []),
    excludedIds: new Set(args.excluded ?? []),
    today: TODAY,
  });
}

describe('serialization', () => {
  it('writes exactly 24 columns in the documented order', () => {
    const row = serializeQueueRow(
      buildQueueRow(scoredContact('rec-1'), { today: TODAY, firstSeen: '', status: 'pending' }),
    );
    expect(row).toHaveLength(QUEUE_COLUMNS);
    expect(row[QUEUE_COLS.attioRecordId]).toBe('rec-1');
    expect(row[QUEUE_COLS.status]).toBe('pending');
    expect(row[QUEUE_COLS.firstSeen]).toBe(TODAY);
    expect(row[QUEUE_COLS.lastScored]).toBe(TODAY);
  });

  it('renders booleans as TRUE/FALSE and a missing llm_score as blank', () => {
    const row = serializeQueueRow(
      buildQueueRow(scoredContact('rec-1'), { today: TODAY, firstSeen: '', status: 'pending' }),
    );
    expect(row[QUEUE_COLS.clamped]).toBe('FALSE');
    expect(row[QUEUE_COLS.hasName]).toBe('TRUE');
    expect(row[QUEUE_COLS.llmScore]).toBe('');
  });

  it('round-trips through the parser', () => {
    const built = buildQueueRow(scoredContact('rec-1'), { today: TODAY, firstSeen: '2026-02-02', status: 'pending' });
    const parsed = parseExistingQueueRow(serializeQueueRow(built))!;
    expect(parsed.attioRecordId).toBe('rec-1');
    expect(parsed.firstSeen).toBe('2026-02-02');
    expect(parsed.status).toBe('pending');
  });

  it('treats a row with no record id as padding, not data', () => {
    expect(parseExistingQueueRow(['', '', ''])).toBeNull();
  });
});

describe("STEP 6 — Bobby's decisions survive re-scoring", () => {
  it.each(['queued_keep', 'queued_archive', 'processed'])('never overwrites a %s row', (status) => {
    const prior = existingRow('rec-1', { status, keeperProbability: 12, reason: 'Bobby decided this' });
    const result = merge({ scored: [scoredContact('rec-1')], existing: [prior] });

    expect(result.counts['preserved-decision']).toBe(1);
    expect(result.rows[0]!.cells).toEqual(prior.cells);
  });

  it('preserves an unrecognized status rather than treating it as pending', () => {
    const prior = existingRow('rec-1', { status: 'quued_keep' }); // typo in the tab
    const result = merge({ scored: [scoredContact('rec-1')], existing: [prior] });

    expect(result.counts['preserved-decision']).toBe(1);
    expect(result.rows[0]!.cells).toEqual(prior.cells);
    expect(result.warnings.join(' ')).toContain('unrecognized status');
  });

  it('re-scores a pending row and preserves its first_seen', () => {
    const prior = existingRow('rec-1', { status: 'pending', firstSeen: '2026-03-03' });
    const result = merge({ scored: [scoredContact('rec-1')], existing: [prior] });

    expect(result.counts.rescored).toBe(1);
    const cells = result.rows[0]!.cells!;
    expect(cells[QUEUE_COLS.firstSeen]).toBe('2026-03-03');
    expect(cells[QUEUE_COLS.lastScored]).toBe(TODAY);
  });

  it('treats a blank status as pending', () => {
    const result = merge({ scored: [scoredContact('rec-1')], existing: [existingRow('rec-1', { status: '' })] });
    expect(result.counts.rescored).toBe(1);
  });

  it('gives a brand-new contact first_seen = today and status pending', () => {
    const result = merge({ scored: [scoredContact('rec-1')] });
    expect(result.counts.new).toBe(1);
    const cells = result.rows[0]!.cells!;
    expect(cells[QUEUE_COLS.firstSeen]).toBe(TODAY);
    expect(cells[QUEUE_COLS.status]).toBe('pending');
  });
});

describe('STEP 6 — skipped rows come back', () => {
  it('stays skipped while the window is open and nothing new arrived', () => {
    const prior = existingRow('rec-1', { status: 'skipped', skipUntil: '2026-12-01' });
    const result = merge({ scored: [scoredContact('rec-1')], existing: [prior] });

    expect(result.counts['preserved-skip']).toBe(1);
    expect(result.rows[0]!.cells).toEqual(prior.cells);
  });

  it('returns to pending once skip_until has passed', () => {
    const prior = existingRow('rec-1', { status: 'skipped', skipUntil: '2026-08-08' });
    const result = merge({ scored: [scoredContact('rec-1')], existing: [prior] });

    expect(result.counts['reactivated-skip-expired']).toBe(1);
    expect(result.rows[0]!.cells![QUEUE_COLS.status]).toBe('pending');
    expect(result.rows[0]!.cells![QUEUE_COLS.skipUntil]).toBe('');
  });

  it('returns to pending IMMEDIATELY when new interaction data has arrived, window open or not', () => {
    const prior = existingRow('rec-1', { status: 'skipped', skipUntil: '2027-01-01', lastScored: '2026-06-01' });
    const scored = scoredContact('rec-1', { firstInteractionAt: '2026-01-01', lastInteractionAt: '2026-08-01' });
    const result = merge({ scored: [scored], existing: [prior] });

    expect(result.counts['reactivated-new-evidence']).toBe(1);
    expect(result.rows[0]!.cells![QUEUE_COLS.status]).toBe('pending');
  });

  it('counts a later last-interaction date as new evidence', () => {
    const prior = existingRow('rec-1', { status: 'skipped', skipUntil: '2027-01-01', lastScored: '2026-06-01' });
    const scored = scoredContact('rec-1', { lastInteractionAt: '2026-07-15' });
    expect(hasNewEvidence(prior, scored)).toBe(true);
  });

  it('does not reactivate when the last interaction predates the last scoring', () => {
    const prior = existingRow('rec-1', { status: 'skipped', skipUntil: '2027-01-01', lastScored: '2026-06-01' });
    const scored = scoredContact('rec-1', { lastInteractionAt: '2026-05-01' });
    expect(hasNewEvidence(prior, scored)).toBe(false);
  });

  it('does not reactivate when the record carries no interaction date at all', () => {
    const prior = existingRow('rec-1', { status: 'skipped', skipUntil: '2027-01-01', lastScored: '2026-06-01' });
    expect(hasNewEvidence(prior, scoredContact('rec-1'))).toBe(false);
  });
});

describe('STEP 6 — rows that leave the queue', () => {
  it('drops a row whose contact has since acquired a bhc_contact_id', () => {
    const result = merge({ existing: [existingRow('rec-1')], bridged: ['rec-1'] });
    expect(result.counts['dropped-bridged']).toBe(1);
    expect(result.rows[0]!.cells).toBeNull();
  });

  it('drops a row whose contact is now in Contact_Exclusions', () => {
    const result = merge({ existing: [existingRow('rec-1')], excluded: ['rec-1'] });
    expect(result.counts['dropped-excluded']).toBe(1);
    expect(result.rows[0]!.cells).toBeNull();
  });

  it('KEEPS a row it simply did not see this run — a partial enumeration must not discard decisions', () => {
    const prior = existingRow('rec-1', { status: 'queued_keep' });
    const result = merge({ existing: [prior] });

    expect(result.counts['kept-unseen']).toBe(1);
    expect(result.rows[0]!.cells).toEqual(prior.cells);
    expect(result.warnings.join(' ')).toContain('not seen in this run');
  });
});

describe('ordering', () => {
  // The build spec says "keepers and unclear DESC, junk ASC (shakiest junk
  // calls surface first)" — but ascending by score puts the MOST confident
  // junk first, not the shakiest. The literal instruction is implemented; the
  // contradiction is flagged in docs/contacts-triage-notes.md #4. Low stakes
  // either way: the spec also says sorting is Aida's job, and both the score
  // and the column are recorded for it.
  it('sorts keepers and unclear DESC, junk ASC (literal reading)', () => {
    const rows = sortMerged([
      { attioRecordId: 'junk-low', action: 'new', cells: [], column: 'junk', keeperProbability: 3 },
      { attioRecordId: 'keeper-high', action: 'new', cells: [], column: 'keepers', keeperProbability: 95 },
      { attioRecordId: 'junk-high', action: 'new', cells: [], column: 'junk', keeperProbability: 24 },
      { attioRecordId: 'unclear-low', action: 'new', cells: [], column: 'unclear', keeperProbability: 30 },
      { attioRecordId: 'keeper-low', action: 'new', cells: [], column: 'keepers', keeperProbability: 76 },
      { attioRecordId: 'unclear-high', action: 'new', cells: [], column: 'unclear', keeperProbability: 70 },
    ]);

    expect(rows.map((r) => r.attioRecordId)).toEqual([
      'keeper-high',
      'keeper-low',
      'unclear-high',
      'unclear-low',
      'junk-low',
      'junk-high',
    ]);
  });

  it('puts dropped rows last, where they are excluded from the write', () => {
    const rows = sortMerged([
      { attioRecordId: 'dropped', action: 'dropped-bridged', cells: null, column: 'junk', keeperProbability: 0 },
      { attioRecordId: 'kept', action: 'new', cells: [], column: 'junk', keeperProbability: 0 },
    ]);
    expect(rows[rows.length - 1]!.attioRecordId).toBe('dropped');
  });
});

describe('band distribution', () => {
  it('buckets scores in tens and counts the three bands', () => {
    const dist = distributionOf([0, 5, 26, 50, 74, 75, 100]);
    expect(dist.junk).toBe(2);
    expect(dist.unclear).toBe(3);
    expect(dist.keepers).toBe(2);
    expect(dist.buckets[0]).toBe(2);
    expect(dist.buckets[10]).toBe(1);
    expect(dist.buckets.reduce((a, b) => a + b, 0)).toBe(7);
  });
});
