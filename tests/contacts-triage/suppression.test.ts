/**
 * STEP 1b suppression — pure, no credentials.
 *
 * ⚠ FIXTURES ARE THE REAL ROWS, read live from Master_ID on 2026-09-01, not a
 * tidied version. That matters here more than usual, because the awkward parts
 * ARE the logic: three different shapes share `Location: SUPERSEDED`, the
 * annotations accrete a second clause after ` · `, one name is in ALL CAPS and
 * one carries a diacritic. An idealised fixture of "a superseded row" would
 * exercise none of it.
 */

import { describe, expect, it } from 'vitest';

import {
  classifySuppression,
  leadAnnotation,
  nameKeyOf,
  readSuppressionIndex,
} from '../../src/passes/contacts-triage/suppression.js';
import { readExclusionIndex } from '../../src/passes/contacts-triage/exclusions.js';
import type { SheetRow } from '../../src/lib/sheets.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';

/** A Master_ID row: A BHC_ID · B Full_Name · C Location · D Google_Row · E Attio_Record_ID · F Notes */
const row = (a: string, b: string, c: string, f: string): SheetRow => [a, b, c, '', '', f];

// --- The real rows. Sheet row = index + 2. ----------------------------------
const RAYMOND_456_NOTE =
  'SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact. Attio record 9878628f ' +
  'deleted by Bobby. Paired with BHC-02444 (Google_Row 383) as a Reconciler D1 duplicate; both retired ' +
  'rather than merged. BHC_ID and Attio_Record_ID cleared; Contacts row 383 emptied. · Location set to ' +
  'SUPERSEDED 2026-08-30: identity fields were cleared during human-confirmed cleanup but Location was ' +
  'left at its original value, so this row re-flagged as S2 and S3 on every Reconciler run.';

const RAYMOND_1585_NOTE =
  'SCRAPPED 2026-08-05: duplicate of BHC-01889 (Raymond Yang), TNB staff. Both records retired: staff, ' +
  'not a contact. Contacts row 383 emptied. · Location set to SUPERSEDED 2026-08-30: identity fields were ' +
  'cleared during human-confirmed cleanup but Location was left at its original value.';

const BJORN_NOTE =
  'ORPHAN CLEARED: duplicate of BHC-01811 (Björn Ahlstedt). Minted by HF_Sync ' +
  'HF-SYNC-REPAIR2-1783385130648 — same LinkedIn-URL dedup gap as BHC-02463. · Location set to SUPERSEDED';

/**
 * Index 0 -> sheet row 2. Padding rows keep Raymond at 456/1585 without
 * carrying 2,500 fixture rows: only the two Raymond rows, the tombstone, the
 * active row and the awkward names are real content.
 */
function realisticMaster(): SheetRow[] {
  const rows: SheetRow[] = [];
  const put = (sheetRow: number, r: SheetRow) => {
    while (rows.length < sheetRow - 2) rows.push(['', '', 'ATTIO', '', '', '']);
    rows[sheetRow - 2] = r;
  };
  put(363, row('', 'Ronald Buse', 'SUPERSEDED', 'ORPHAN CLEARED: duplicate of BHC-00293 (Ron Buse, Google_Row 293). Same person.'));
  put(456, row('', 'Raymond Yang', 'SUPERSEDED', RAYMOND_456_NOTE));
  // Merge tombstone: BHC_ID present, column B BLANK, the name only in the note.
  put(582, row('BHC-00537', '', 'SUPERSEDED', 'Merged into BHC-01195 · 2026-08-10 · was Jenny Kim'));
  // SUPERSEDED but ACTIVE: both A and B populated. Must never suppress.
  put(962, row('BHC-00920', 'Rachel Marantz', 'SUPERSEDED', 'A3-FIXED: Attio record_id updated by Reconciler Fix.'));
  put(1548, row('', 'JEREMY HODERS', 'SUPERSEDED', 'ORPHAN CLEARED: duplicate of BHC-02089 (Jeremy Hoders).'));
  put(1585, row('', 'Raymond Yang', 'SUPERSEDED', RAYMOND_1585_NOTE));
  put(2451, row('', 'Björn Ahlstedt', 'SUPERSEDED', BJORN_NOTE));
  // A live bridged contact who SHARES A FIRST NAME with a scrapped one.
  put(723, row('BHC-00679', 'Raymond Worsdale', 'ATTIO', ''));
  return rows;
}

const contact = (over: Partial<UnbridgedContact>): UnbridgedContact => ({
  attioRecordId: 'rec-x',
  name: null,
  primaryEmail: null,
  allEmails: [],
  company: null,
  companyRecordId: null,
  jobTitle: null,
  description: null,
  linkedin: null,
  createdAt: null,
  strengthLabel: null,
  strengthLegacy: null,
  firstInteractionAt: null,
  lastInteractionAt: null,
  lastInteractionChannel: null,
  lastInteractionDirection: null,
  lastInteractionSubject: null,
  lastMeetingSummary: null,
  ...over,
});

const EMPTY_EXCLUSIONS = readExclusionIndex([]);

describe('the retired-identity shape gate', () => {
  const index = readSuppressionIndex(realisticMaster());

  it('indexes only rows with a BLANK BHC_ID and a name in column B', () => {
    expect(index.supersededTotal).toBe(7);
    expect(index.retiredCount).toBe(5); // Ronald, Raymond x2, JEREMY, Björn
  });

  it('IGNORES a merge tombstone — that person still exists under another BHC_ID', () => {
    // Row 582: "Merged into BHC-01195 · was Jenny Kim". Suppressing Jenny Kim
    // would hide a contact who was never retired, only renumbered.
    expect(index.mergeTombstoneCount).toBe(1);
    expect(index.byNameKey.has(nameKeyOf('Jenny Kim'))).toBe(false);
    expect(classifySuppression(contact({ name: 'Jenny Kim' }), index, EMPTY_EXCLUSIONS)).toBeNull();
  });

  it('IGNORES a SUPERSEDED row that still carries a BHC_ID AND a name', () => {
    // Row 962, Rachel Marantz, BHC-00920 — an ACTIVE contact whose Location was
    // set to SUPERSEDED during the 2026-08-30 cleanup. This is the row that
    // makes "blank column A" load-bearing rather than incidental.
    expect(index.activeSupersededRows).toEqual([962]);
    expect(classifySuppression(contact({ name: 'Rachel Marantz' }), index, EMPTY_EXCLUSIONS)).toBeNull();
  });

  it('never harvests a name out of the annotation prose', () => {
    // "was Jenny Kim" appears in row 582's note and nowhere else. If names
    // were read from column F, this would match.
    for (const key of index.byNameKey.keys()) {
      expect(key).not.toContain('jenny');
    }
  });
});

describe('⚠ Raymond Yang — the case this step exists for', () => {
  const index = readSuppressionIndex(realisticMaster());

  it('suppresses BOTH of his current Attio records, naming both Master_ID rows', () => {
    const epic = classifySuppression(
      contact({ attioRecordId: '97af6c95-f985-4c44-9c32-6fe15367da7b', name: 'Raymond Yang', primaryEmail: 'raymond.yang@xa.epicgames.com' }),
      index,
      EMPTY_EXCLUSIONS,
    );
    const tnb = classifySuppression(
      contact({ attioRecordId: 'fd52a57d-d3bb-4e9a-805c-2775e2e19058', name: 'Raymond Yang', primaryEmail: 'raymondy@thenewblank.com' }),
      index,
      EMPTY_EXCLUSIONS,
    );

    expect(epic).not.toBeNull();
    expect(tnb).not.toBeNull();
    expect(epic!.source).toBe('master-id-superseded');
    expect(epic!.kind).toBe('SCRAPPED');
    expect(epic!.masterRows).toEqual([456, 1585]);
    expect(tnb!.masterRows).toEqual([456, 1585]);
  });

  it('⚠ quotes the original annotation verbatim, so the suppression is auditable', () => {
    const s = classifySuppression(contact({ name: 'Raymond Yang' }), index, EMPTY_EXCLUSIONS)!;
    expect(s.reason).toContain('SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact');
    expect(s.reason).toContain('456');
    expect(s.reason).toContain('1585');
  });

  it('does NOT drag the 2026-08-30 Location housekeeping clause into the quote', () => {
    const s = classifySuppression(contact({ name: 'Raymond Yang' }), index, EMPTY_EXCLUSIONS)!;
    expect(s.reason).not.toContain('re-flagged as S2 and S3');
    expect(s.reason).not.toContain('Location set to SUPERSEDED 2026-08-30');
  });
});

describe('⚠ the strict name key — a shared first name must NOT suppress', () => {
  const index = readSuppressionIndex(realisticMaster());

  it('leaves Raymond Worsdale alone despite sharing "Raymond" with a scrapped row', () => {
    // verifyName() would return MATCH here: one significant word in common is
    // its whole rule. That gate guards a proposed pair; it cannot generate
    // matches. Raymond Worsdale is BHC-00679, live at NBCUniversal.
    expect(classifySuppression(contact({ name: 'Raymond Worsdale' }), index, EMPTY_EXCLUSIONS)).toBeNull();
  });

  it('requires the whole significant-word set, not an overlap', () => {
    expect(nameKeyOf('Raymond Yang')).not.toBe(nameKeyOf('Raymond Worsdale'));
    expect(classifySuppression(contact({ name: 'Raymond' }), index, EMPTY_EXCLUSIONS)).toBeNull();
    expect(classifySuppression(contact({ name: 'Raymond Yang Jr' }), index, EMPTY_EXCLUSIONS)).toBeNull();
  });

  it('is case- and order-insensitive, because Master_ID holds "JEREMY HODERS" in caps', () => {
    expect(classifySuppression(contact({ name: 'Jeremy Hoders' }), index, EMPTY_EXCLUSIONS)).not.toBeNull();
    expect(nameKeyOf('Hoders Jeremy')).toBe(nameKeyOf('JEREMY HODERS'));
  });

  it('strips diacritics, because Björn Ahlstedt is one of the retired rows', () => {
    expect(classifySuppression(contact({ name: 'Bjorn Ahlstedt' }), index, EMPTY_EXCLUSIONS)).not.toBeNull();
    expect(classifySuppression(contact({ name: 'Björn Ahlstedt' }), index, EMPTY_EXCLUSIONS)).not.toBeNull();
  });

  it('a contact with no name is never suppressed by name — 25% of the population has none', () => {
    expect(classifySuppression(contact({ name: null }), index, EMPTY_EXCLUSIONS)).toBeNull();
    expect(classifySuppression(contact({ name: '   ' }), index, EMPTY_EXCLUSIONS)).toBeNull();
    expect(nameKeyOf('...')).toBe('');
  });
});

describe('leadAnnotation', () => {
  it('stops at the first appended clause', () => {
    expect(leadAnnotation(RAYMOND_456_NOTE)).toBe(
      'SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact',
    );
  });

  it('keeps a single-sentence note whole and tolerates an empty one', () => {
    expect(leadAnnotation('ORPHAN CLEARED: duplicate of BHC-02089 (Jeremy Hoders).')).toBe(
      'ORPHAN CLEARED: duplicate of BHC-02089 (Jeremy Hoders)',
    );
    expect(leadAnnotation('')).toBe('');
  });

  it('splits on the appended clause even when the first clause has NO period', () => {
    // Column F accretes with ` · ` and not every clause ends in a sentence
    // stop — the merge tombstones ("Merged into BHC-01195 · 2026-08-10 · was
    // Jenny Kim") are proof that period-free notes exist in this column. With
    // only a sentence-end rule, the 2026-08-30 housekeeping text would be
    // quoted as part of the original decision.
    expect(leadAnnotation('SCRAPPED 2026-08-05: TNB staff · Location set to SUPERSEDED 2026-08-30'))
      .toBe('SCRAPPED 2026-08-05: TNB staff');
  });

  it('caps a runaway note rather than pasting it whole into a report line', () => {
    const long = `SCRAPPED: ${'x'.repeat(500)}`;
    expect(leadAnnotation(long).length).toBeLessThanOrEqual(300);
  });
});

describe('Contact_Exclusions is consulted first', () => {
  const index = readSuppressionIndex(realisticMaster());
  // Real shape: A attio_record_id · B name · C email · D reason · E date · F recoverable · G source
  const exclusions = readExclusionIndex([
    ['rec-gamestop', 'GameStop', 'orders@gamestop.com', 'transactional', '2026-08-09', 'FALSE', 'rule'],
    ['', 'Aunt Marge', 'marge@example.com', 'family', '2026-08-09', 'FALSE', 'bobby'],
  ]);

  it('matches by record id', () => {
    const s = classifySuppression(contact({ attioRecordId: 'rec-gamestop' }), index, exclusions)!;
    expect(s.source).toBe('contact-exclusions');
    expect(s.matchedOn).toBe('record-id');
  });

  it('matches by email, which is the only way a hand-added row can work', () => {
    const s = classifySuppression(
      contact({ attioRecordId: 'rec-new', primaryEmail: 'MARGE@example.com' }),
      index,
      exclusions,
    )!;
    expect(s.matchedOn).toBe('email');
  });

  it('takes precedence over a name match, because it cannot false-positive', () => {
    const s = classifySuppression(
      contact({ attioRecordId: 'rec-gamestop', name: 'Raymond Yang' }),
      index,
      exclusions,
    )!;
    expect(s.source).toBe('contact-exclusions');
  });
});

describe('the index degrades safely', () => {
  it('reports an empty index rather than silently suppressing nothing', () => {
    const index = readSuppressionIndex([row('BHC-1', 'Someone', 'ATTIO', '')]);
    expect(index.retiredCount).toBe(0);
    expect(index.supersededTotal).toBe(0);
  });

  it('counts a retired row with an unusable name instead of dropping it quietly', () => {
    const index = readSuppressionIndex([row('', '...', 'SUPERSEDED', 'SCRAPPED: punctuation only')]);
    expect(index.retiredCount).toBe(0);
    expect(index.unusableRows).toEqual([2]);
  });

  it('is case-insensitive on the Location value', () => {
    expect(readSuppressionIndex([row('', 'Ann Onymous', 'superseded', 'SCRAPPED: x')]).retiredCount).toBe(1);
  });
});
