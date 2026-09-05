/**
 * STEP 3 PART A — the duplicate half of Contacts_Triage_Queue.
 *
 * ⚠ IDEMPOTENCY IS THE GATE, so it is what most of this file tests. A queue
 * that re-asks a question already answered trains the user to ignore it, which
 * costs more than the queue is worth.
 *
 * The fixtures are the live shapes: a 24-wide legacy row (the real tab's width
 * before this step), Raymond Yang's two unbridged records, and Chuck Granade's
 * typo record sitting on a row already marked `processed` by the 2026-08-09
 * triage run.
 */

import { describe, expect, it } from 'vitest';

import {
  DUP_COLS,
  DUPLICATE_COLUMNS,
  QUEUE_COLS,
  QUEUE_COLUMNS,
  TRIAGE_COLUMNS,
} from '../../src/config/triage-constants.js';
import type { CivilDate } from '../../src/lib/dates.js';
import {
  classificationOf,
  defaultSkipUntil,
  droppedSecondBhcId,
  mergeDuplicateCells,
  readDuplicateState,
  serializeDuplicateCells,
} from '../../src/passes/contacts-triage/duplicate-queue.js';
import {
  buildBridgedNameIndex,
  detectDuplicates,
  unbridgedSide,
} from '../../src/passes/contacts-triage/duplicates.js';
import { mergeQueue, parseExistingQueueRow } from '../../src/passes/contacts-triage/queue.js';
import { readSuppressionIndex } from '../../src/passes/contacts-triage/suppression.js';
import type { DuplicateCandidate } from '../../src/passes/contacts-triage/duplicates.js';
import { contact } from './fixtures.js';

const TODAY = '2026-09-04' as CivilDate;
const EMPTY_SUPPRESSION = readSuppressionIndex([]);

function bridgedFrom(bhcId: string, c: Parameters<typeof contact>[0]) {
  return { ...unbridgedSide(contact(c)), bhcId };
}

const CHUCK_BRIDGED = bridgedFrom('BHC-02338', {
  attioRecordId: 'chuck-bridged',
  name: 'Chuck Granade',
  primaryEmail: 'chuck@thenewblank.com',
  allEmails: ['chuck@thenewblank.com', 'chuck@crrnt.co'],
});

const CHUCK_TYPO = contact({
  attioRecordId: '16a589c8',
  name: 'Chuck Granade',
  primaryEmail: 'chuck@thenewblanks.com',
  allEmails: ['chuck@thenewblanks.com'],
  firstInteractionAt: '2026-06-23' as CivilDate,
  lastInteractionAt: '2026-06-25' as CivilDate,
  strengthLabel: 'Very weak',
});

function candidatesFor(unbridged: ReturnType<typeof contact>[], bridged = [CHUCK_BRIDGED]) {
  const d = detectDuplicates({
    unbridged,
    index: buildBridgedNameIndex(bridged),
    suppression: EMPTY_SUPPRESSION,
  });
  return new Map(d.candidates.map((c) => [c.subject.attioRecordId, c]));
}

const chuckCandidate = (): DuplicateCandidate => candidatesFor([CHUCK_TYPO]).get('16a589c8')!;

/** A legacy row: 24 wide, exactly as the live tab holds them today. */
function legacyRow(id: string, status: string): unknown[] {
  const row = new Array<unknown>(TRIAGE_COLUMNS).fill('');
  row[QUEUE_COLS.attioRecordId] = id;
  row[QUEUE_COLS.name] = 'Chuck Granade';
  row[QUEUE_COLS.status] = status;
  row[QUEUE_COLS.column] = 'junk';
  row[QUEUE_COLS.keeperProbability] = 12;
  return row;
}

describe('serializeDuplicateCells', () => {
  it('writes exactly the duplicate half, and nothing wider', () => {
    const cells = serializeDuplicateCells(chuckCandidate(), {
      today: TODAY,
      status: 'pending',
      skipUntil: '',
      firstSeen: '',
    });
    expect(cells).toHaveLength(DUPLICATE_COLUMNS);
  });

  it('classifies the typo record as TYPO_DOMAIN — its own card, not the four-action one', () => {
    const c = chuckCandidate();
    expect(classificationOf(c)).toBe('TYPO_DOMAIN');
    const cells = serializeDuplicateCells(c, { today: TODAY, status: 'pending', skipUntil: '', firstSeen: '' });
    expect(cells[DUP_COLS.classification - DUP_COLS.status]).toBe('TYPO_DOMAIN');
  });

  it('carries the delete-vs-merge evidence EXPLICITLY, not via the triage columns', () => {
    // ⚠ A duplicate-only row has blank triage columns, so `connection_strength`
    // (X) and the span (M) are empty on exactly the rows the TYPO_DOMAIN card
    // needs them for. The live pair is two days apart and Very weak — the
    // evidence the card shows to default to delete.
    const cells = serializeDuplicateCells(chuckCandidate(), {
      today: TODAY,
      status: 'pending',
      skipUntil: '',
      firstSeen: '',
    });
    expect(cells[DUP_COLS.firstInteraction - DUP_COLS.status]).toBe('2026-06-23');
    expect(cells[DUP_COLS.lastInteraction - DUP_COLS.status]).toBe('2026-06-25');
    expect(cells[DUP_COLS.strength - DUP_COLS.status]).toBe('Very weak');
  });

  it('carries a per-record app.attio.com link for both sides', () => {
    const cells = serializeDuplicateCells(chuckCandidate(), {
      today: TODAY,
      status: 'pending',
      skipUntil: '',
      firstSeen: '',
    });
    expect(cells[DUP_COLS.subjectUrl - DUP_COLS.status]).toContain('/person/16a589c8/');
    expect(cells[DUP_COLS.matchUrls - DUP_COLS.status]).toContain('/person/chuck-bridged/');
  });

  it('keeps the ORIGINAL first_seen when one is supplied', () => {
    const cells = serializeDuplicateCells(chuckCandidate(), {
      today: TODAY,
      status: 'pending',
      skipUntil: '',
      firstSeen: '2026-08-01',
    });
    expect(cells[DUP_COLS.firstSeen - DUP_COLS.status]).toBe('2026-08-01');
    expect(cells[DUP_COLS.lastDetected - DUP_COLS.status]).toBe(TODAY);
  });
});

describe('droppedSecondBhcId', () => {
  it('is BLANK when only one bridged record matches — the live case for all 18', () => {
    expect(droppedSecondBhcId(chuckCandidate())).toBe('');
  });

  it('names the BHC_ID a merge would silently discard when two bridged records match', () => {
    // `bhc_contact_id` is is_unique:false and single-value, so on a merge the
    // primary's value wins and the secondary's is dropped with NO error.
    const second = bridgedFrom('BHC-09999', {
      attioRecordId: 'chuck-2',
      name: 'Chuck Granade',
      primaryEmail: 'chuck@elsewhere.com',
      allEmails: ['chuck@elsewhere.com'],
    });
    const c = candidatesFor([CHUCK_TYPO], [CHUCK_BRIDGED, second]).get('16a589c8')!;
    expect(c.bridgedMatches).toHaveLength(2);
    expect(droppedSecondBhcId(c)).toBe('BHC-09999');
  });
});

describe('mergeDuplicateCells — ⚠ THE IDEMPOTENCY GATE', () => {
  const state = (status: string, skipUntil = '', firstSeen = '2026-09-01') => {
    const row = new Array<unknown>(QUEUE_COLUMNS).fill('');
    row[DUP_COLS.status] = status;
    row[DUP_COLS.skipUntil] = skipUntil;
    row[DUP_COLS.firstSeen] = firstSeen;
    row[DUP_COLS.classification] = 'TYPO_DOMAIN';
    row[DUP_COLS.cautions] = 'the original cautions';
    return readDuplicateState(row as string[]);
  };

  it('raises a candidate that has never been seen', () => {
    const out = mergeDuplicateCells(chuckCandidate(), null, TODAY);
    expect(out.action).toBe('duplicate-new');
    expect(out.cells[DUP_COLS.status - DUP_COLS.status]).toBe('pending');
  });

  it('refreshes a still-pending candidate without changing its first_seen', () => {
    const out = mergeDuplicateCells(chuckCandidate(), state('pending'), TODAY);
    expect(out.action).toBe('duplicate-refreshed');
    expect(out.cells[DUP_COLS.firstSeen - DUP_COLS.status]).toBe('2026-09-01');
  });

  // ⚠⚠ THE TEST THIS STEP EXISTS FOR.
  it('NEVER re-raises a resolved candidate, and re-emits its cells BYTE FOR BYTE', () => {
    const prior = state('resolved_delete');
    const out = mergeDuplicateCells(chuckCandidate(), prior, TODAY);
    expect(out.action).toBe('duplicate-preserved-decision');
    expect(out.cells).toEqual(prior.cells);
    // Including last_detected: a preserved row is bit-identical across runs, so
    // a diff of the tab shows nothing at all.
    expect(out.cells[DUP_COLS.lastDetected - DUP_COLS.status]).not.toBe(TODAY);
  });

  it('treats an UNRECOGNISED status as a decision, and says so', () => {
    // A typo in Bobby's column must not be enough to re-ask a question he has
    // already answered.
    const prior = state('resolvd_delete');
    const out = mergeDuplicateCells(chuckCandidate(), prior, TODAY);
    expect(out.action).toBe('duplicate-preserved-decision');
    expect(out.cells).toEqual(prior.cells);
    expect(out.warning).toContain('not recognised');
  });

  it('holds a skip until its window expires, then re-raises', () => {
    const unexpired = mergeDuplicateCells(chuckCandidate(), state('skipped', '2026-12-01'), TODAY);
    expect(unexpired.action).toBe('duplicate-preserved-skip');

    const expired = mergeDuplicateCells(chuckCandidate(), state('skipped', '2026-09-01'), TODAY);
    expect(expired.action).toBe('duplicate-reactivated-skip-expired');
    expect(expired.cells[DUP_COLS.status - DUP_COLS.status]).toBe('pending');
  });

  it('keeps a human answer even after the candidate stops firing', () => {
    // The row IS the memory. Clearing it would re-ask the question the moment
    // the candidate reappears.
    const out = mergeDuplicateCells(null, state('resolved_merge'), TODAY);
    expect(out.action).toBe('duplicate-preserved-decision');
  });

  it('clears a stale PENDING half when the candidate stops firing', () => {
    const out = mergeDuplicateCells(null, state('pending'), TODAY);
    expect(out.action).toBe('duplicate-cleared');
    expect(out.cells.every((c) => c === '')).toBe(true);
  });

  it('reads a 24-wide legacy row as having no duplicate half at all', () => {
    const parsed = readDuplicateState(legacyRow('x', 'processed') as string[]);
    expect(parsed.absent).toBe(true);
    expect(parsed.status).toBe('');
  });

  it('produces a stable skip window', () => {
    expect(defaultSkipUntil(TODAY)).toBe('2026-10-04');
  });
});

describe('mergeQueue — duplicate rows in the tab', () => {
  const base = {
    scored: [],
    bridgedIds: new Set<string>(),
    today: TODAY,
  };

  it('gives an excluded candidate a row with NO triage card in it', () => {
    const result = mergeQueue({
      ...base,
      existing: [],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    const row = result.rows.find((r) => r.attioRecordId === '16a589c8')!;
    expect(row.action).toBe('duplicate-only');
    const cells = row.cells!;
    expect(cells[QUEUE_COLS.status]).toBe('');
    expect(cells[QUEUE_COLS.column]).toBe('');
    expect(cells[QUEUE_COLS.keeperProbability]).toBe('');
    expect(cells[DUP_COLS.status]).toBe('pending');
    expect(result.duplicateRowsWritten).toBe(1);
  });

  it('preserves a `processed` TRIAGE row while asking the duplicate question for the first time', () => {
    // ⚠ THE LIVE CASE. Chuck Granade carries `status: processed` from the
    // 2026-08-09 triage run, and his duplicate question has never been asked.
    // On a shared status column he would never be asked it.
    const prior = parseExistingQueueRow(legacyRow('16a589c8', 'processed') as string[])!;
    const result = mergeQueue({
      ...base,
      existing: [prior],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    const row = result.rows.find((r) => r.attioRecordId === '16a589c8')!;
    expect(row.action).toBe('kept-for-duplicate');
    const cells = row.cells!;
    // Triage half untouched.
    expect(cells.slice(0, TRIAGE_COLUMNS)).toEqual(prior.cells.slice(0, TRIAGE_COLUMNS));
    expect(cells[QUEUE_COLS.status]).toBe('processed');
    // Duplicate half asked.
    expect(cells[DUP_COLS.status]).toBe('pending');
    expect(cells[DUP_COLS.classification]).toBe('TYPO_DOMAIN');
  });

  it('drops an excluded row that has no duplicate question', () => {
    const prior = parseExistingQueueRow(legacyRow('someone-else', 'pending') as string[])!;
    const result = mergeQueue({
      ...base,
      existing: [prior],
      excludedIds: new Set(['someone-else']),
      duplicates: new Map(),
    });
    expect(result.rows.find((r) => r.attioRecordId === 'someone-else')!.action).toBe('dropped-excluded');
  });

  it('drops a candidate that has since become BRIDGED — that IS the answer', () => {
    const result = mergeQueue({
      ...base,
      existing: [],
      excludedIds: new Set<string>(),
      bridgedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    expect(result.rows.find((r) => r.attioRecordId === '16a589c8')).toBeUndefined();
  });

  it('is IDEMPOTENT: a second run over its own output changes nothing', () => {
    const first = mergeQueue({
      ...base,
      existing: [],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    const firstRows = first.rows.filter((r) => r.cells).map((r) => r.cells!);

    const second = mergeQueue({
      ...base,
      existing: firstRows.map((c) => parseExistingQueueRow(c as string[])!),
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    const secondRows = second.rows.filter((r) => r.cells).map((r) => r.cells!);
    expect(secondRows).toEqual(firstRows);
  });

  it('is IDEMPOTENT after a human resolves one: the row is re-emitted unchanged', () => {
    const first = mergeQueue({
      ...base,
      existing: [],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    const resolved = [...first.rows.find((r) => r.attioRecordId === '16a589c8')!.cells!];
    resolved[DUP_COLS.status] = 'resolved_delete';

    const second = mergeQueue({
      ...base,
      existing: [parseExistingQueueRow(resolved as string[])!],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    const row = second.rows.find((r) => r.attioRecordId === '16a589c8')!;
    expect(row.cells).toEqual(resolved);
    expect(second.duplicateCounts['duplicate-preserved-decision']).toBe(1);

    // ...and a THIRD run still leaves it alone.
    const third = mergeQueue({
      ...base,
      existing: [parseExistingQueueRow(row.cells as string[])!],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    expect(third.rows.find((r) => r.attioRecordId === '16a589c8')!.cells).toEqual(resolved);
  });

  it('counts ONLY the rows that carry a duplicate question', () => {
    // A mixed tab: one row with a question, one without. A counter that just
    // counts rows would report 2 and the report would overstate the card.
    const plain = new Array<unknown>(TRIAGE_COLUMNS).fill('');
    plain[QUEUE_COLS.attioRecordId] = 'no-question';
    plain[QUEUE_COLS.status] = 'pending';
    const result = mergeQueue({
      ...base,
      existing: [parseExistingQueueRow(plain as string[])!],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    expect(result.rows.filter((r) => r.cells).length).toBe(2);
    expect(result.duplicateRowsWritten).toBe(1);
  });

  it('writes rows the full width, so Sheets cannot reject the batch', () => {
    const result = mergeQueue({
      ...base,
      existing: [],
      excludedIds: new Set(['16a589c8']),
      duplicates: candidatesFor([CHUCK_TYPO]),
    });
    for (const row of result.rows) {
      if (row.cells) expect(row.cells).toHaveLength(QUEUE_COLUMNS);
    }
  });
});
