/**
 * The manual exclusion path — the stated answer for in-laws and
 * differently-named relatives that surname matching cannot catch.
 */

import { describe, expect, it } from 'vitest';

import { matchExclusion, readExclusionIndex, serializeExclusion } from '../../src/passes/contacts-triage/exclusions.js';
import { EXCLUSIONS_COLS } from '../../src/config/triage-constants.js';
import type { CivilDate } from '../../src/lib/dates.js';
import { contact } from './fixtures.js';

const TODAY = '2026-08-09' as CivilDate;

describe('readExclusionIndex', () => {
  it('indexes by record id AND email, so a hand-added row works either way', () => {
    const index = readExclusionIndex([
      ['rec-1', 'Ruled Out', 'ruled@out.com', 'bobby archived', '2026-06-01', 'FALSE', 'bobby'],
      ['', 'In-Law', 'inlaw@family.com', 'family', '2026-08-09', 'FALSE', 'bobby'],
    ]);
    expect(index.recordIds.has('rec-1')).toBe(true);
    expect(index.emails.has('inlaw@family.com')).toBe(true);
    expect(index.unusableRows).toBe(0);
  });

  it('lowercases emails so casing in a hand-typed row does not defeat the match', () => {
    const index = readExclusionIndex([['', '', 'InLaw@Family.com', 'family', '', 'FALSE', 'bobby']]);
    expect(index.emails.has('inlaw@family.com')).toBe(true);
  });

  it('counts a row with neither id nor email as unusable rather than ignoring it', () => {
    const index = readExclusionIndex([['', 'Just A Name', '', 'family', '', 'FALSE', 'bobby']]);
    expect(index.unusableRows).toBe(1);
  });

  it('treats a wholly blank row as padding, not a broken entry', () => {
    expect(readExclusionIndex([['', '', '', '', '', '', '']]).unusableRows).toBe(0);
  });
});

describe('matchExclusion', () => {
  const index = readExclusionIndex([
    ['rec-1', 'By Id', '', 'bobby archived', '', 'FALSE', 'bobby'],
    ['', 'By Email', 'inlaw@family.com', 'family', '', 'FALSE', 'bobby'],
  ]);

  it('matches a hand-added row by email when it carries no record id', () => {
    const c = contact({ attioRecordId: 'rec-99', primaryEmail: 'inlaw@family.com', allEmails: ['inlaw@family.com'] });
    expect(matchExclusion(c, index)).toBe('email');
  });

  it('matches a secondary address too', () => {
    const c = contact({ attioRecordId: 'rec-99', primaryEmail: 'work@corp.com', allEmails: ['work@corp.com', 'inlaw@family.com'] });
    expect(matchExclusion(c, index)).toBe('email');
  });

  it('prefers the record id when both would match', () => {
    const c = contact({ attioRecordId: 'rec-1', primaryEmail: 'inlaw@family.com', allEmails: ['inlaw@family.com'] });
    expect(matchExclusion(c, index)).toBe('record-id');
  });

  it('returns null for a contact nobody has ruled on', () => {
    expect(matchExclusion(contact({ attioRecordId: 'rec-new' }), index)).toBeNull();
  });
});

describe('serializeExclusion', () => {
  it('writes the family reason with source rule and recoverable FALSE', () => {
    const cells = serializeExclusion(
      { attioRecordId: 'rec-1', name: 'Jordan Macintosh-Hougham', email: 'j@example.com', reason: 'family', recoverable: false, source: 'rule' },
      TODAY,
    );
    expect(cells[EXCLUSIONS_COLS.reason]).toBe('family');
    expect(cells[EXCLUSIONS_COLS.recoverable]).toBe('FALSE');
    expect(cells[EXCLUSIONS_COLS.source]).toBe('rule');
    expect(cells[EXCLUSIONS_COLS.excludedDate]).toBe(TODAY);
  });
});
