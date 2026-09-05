/**
 * STEP 4 — the minting contract, one describe block per clause.
 *
 * ⚠ EVERY TEST HERE IS MUTATION-CHECKED. Across steps 1 and 2, three tests
 * passed on their first attempt for reasons unrelated to the guard they named —
 * one was decorative until a period-free fixture was added, one mutation hit a
 * TDZ error rather than running, one negative-case fixture differed in two
 * fields so the first check rejected it before the guard under test was
 * reached. None of the three was caught by review. So the bar is not "the test
 * passes"; it is "the test fails when the guard is removed, for the stated
 * reason". The four mutations §5 names are recorded in
 * docs/contacts-mint-notes.md with their observed failure output.
 *
 * FIXTURES ARE LIVE VALUES, read 2026-09-05: max BHC-02530 on both sides, 2,510
 * Attio people of which 255 carry no bhc_contact_id, and the real Raymond Yang
 * suppression rows. An idealised fixture would exercise none of the awkward
 * parts, and the awkward parts are the logic.
 */

import { describe, expect, it } from 'vitest';

import {
  computeNextBhcId,
  formatBhcId,
  parseBhcId,
  projectSerialIds,
} from '../../src/passes/contacts-mint/ids.js';
import {
  blockedByReason,
  selectMintCandidates,
} from '../../src/passes/contacts-mint/candidates.js';
import { planBatch, planMint } from '../../src/passes/contacts-mint/plan.js';
import { readExclusionIndex } from '../../src/passes/contacts-triage/exclusions.js';
import { readSuppressionIndex } from '../../src/passes/contacts-triage/suppression.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function contact(over: Partial<UnbridgedContact> & { attioRecordId: string }): UnbridgedContact {
  return {
    name: 'Jane Doe',
    primaryEmail: 'jane@example.com',
    allEmails: ['jane@example.com'],
    company: null,
    companyRecordId: null,
    jobTitle: null,
    description: null,
    linkedin: null,
    createdAt: '2026-09-01T00:00:00Z',
    strengthLabel: null,
    strengthLegacy: null,
    firstInteractionAt: null,
    lastInteractionAt: null,
    lastInteractionChannel: null,
    lastInteractionDirection: null,
    lastInteractionSubject: null,
    lastMeetingSummary: null,
    ...over,
  } as UnbridgedContact;
}

/** The real Master_ID SUPERSEDED rows for Raymond Yang, rows 456 and 1585. */
const MASTER_ID_ROWS = [
  ['', 'Raymond Yang', 'SUPERSEDED', '', '', 'SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact'],
  ['', 'Raymond Yang', 'SUPERSEDED', '', '', 'SCRAPPED 2026-08-05: duplicate of BHC-01889 (Raymond Yang), TNB staff'],
];

const EMPTY_EXCLUSIONS = readExclusionIndex([]);

function emptySelectionInput() {
  return {
    suppression: readSuppressionIndex(MASTER_ID_ROWS),
    exclusions: EMPTY_EXCLUSIONS,
    duplicateFlagged: new Set<string>(),
    bridged: new Map<string, string>(),
    runDate: '2026-09-05',
  };
}

// ─── CLAUSE 1 ────────────────────────────────────────────────────────────────

describe('clause 1 — the maximum is computed across BOTH systems', () => {
  it('takes the maximum from Attio when Attio leads', () => {
    // MUTATION TARGET #1. Removing Attio from the computation makes this
    // return BHC-02501, colliding with an ID Attio already holds.
    const r = computeNextBhcId(['BHC-02500'], ['BHC-02530']);
    expect(r.holder).toBe('attio');
    expect(r.max).toBe(2530);
    expect(r.nextId).toBe('BHC-02531');
  });

  it('reports the collision the Master_ID-only allocation would have caused', () => {
    const r = computeNextBhcId(['BHC-02500'], ['BHC-02530']);
    expect(r.masterOnlyWouldBe).toBe('BHC-02501');
    expect(r.wouldHaveCollided).toBe(true);
  });

  it('takes the maximum from Master_ID when Master_ID leads', () => {
    const r = computeNextBhcId(['BHC-02530'], ['BHC-02400']);
    expect(r.holder).toBe('master-id');
    expect(r.nextId).toBe('BHC-02531');
    expect(r.wouldHaveCollided).toBe(false);
  });

  it('reports `both` when the systems agree — the live state on 2026-09-05', () => {
    // ⚠ THE CASE THAT MAKES THE MISSING GUARD INVISIBLE. Both sides hold
    // BHC-02530 today, so a Master_ID-only allocation returns the RIGHT answer.
    // A test written only against this state would pass under mutation #1,
    // which is precisely why the Attio-leads case above exists.
    const r = computeNextBhcId(['BHC-02530'], ['BHC-02530']);
    expect(r.holder).toBe('both');
    expect(r.nextId).toBe('BHC-02531');
    expect(r.wouldHaveCollided).toBe(false);
  });

  it('ignores blanks and collects malformed values instead of dropping them', () => {
    const r = computeNextBhcId(['BHC-00001', '', null, 'BHC_00002'], ['not-an-id']);
    expect(r.max).toBe(1);
    expect(r.malformed).toEqual(['BHC_00002', 'not-an-id']);
  });

  it('parses and formats the five-digit live sequence', () => {
    expect(parseBhcId('BHC-02530')).toBe(2530);
    expect(parseBhcId('bhc-00001')).toBe(1);
    expect(parseBhcId('BHC-')).toBeNull();
    expect(formatBhcId(2531)).toBe('BHC-02531');
  });

  it('projects a serial batch as consecutive ids', () => {
    const start = computeNextBhcId(['BHC-02530'], ['BHC-02530']);
    expect(projectSerialIds(start, 3)).toEqual(['BHC-02531', 'BHC-02532', 'BHC-02533']);
  });
});

// ─── CLAUSES 2, 3, 4 ─────────────────────────────────────────────────────────

describe('clauses 2-4 — the write order', () => {
  const cand = { contact: contact({ attioRecordId: 'rec-1' }), sourceContext: 'ctx' };

  it('writes the Master_ID stub BEFORE touching Attio', () => {
    // MUTATION TARGET #2. Reversing the order puts an Attio step first, which
    // is the silent-orphan failure: a stamped record with no bridge row is
    // invisible to every sweep.
    const { steps } = planMint(cand, 'BHC-02531');
    const firstWrite = steps.find((s) => s.kind !== 'read-back');
    expect(firstWrite?.system).toBe('master-id');
    expect(firstWrite?.order).toBe(1);

    const firstAttio = steps.findIndex((s) => s.system === 'attio');
    const firstMaster = steps.findIndex((s) => s.system === 'master-id');
    expect(firstMaster).toBeLessThan(firstAttio);
  });

  it('appends the stub with Location ATTIO and a blank Google_Row', () => {
    const { steps } = planMint(cand, 'BHC-02531');
    expect(steps[0]!.range).toBe('Master_ID!A2:F');
    expect(steps[0]!.values).toEqual(['BHC-02531', 'Jane Doe', 'ATTIO', '', 'rec-1', 'ctx']);
  });

  it('re-stamps rather than creating the Attio record', () => {
    const attio = planMint(cand, 'BHC-02531').steps.filter((s) => s.system === 'attio');
    expect(attio.every((s) => s.recordId === 'rec-1')).toBe(true);
    expect(attio.some((s) => s.kind === 'update' && s.field === 'bhc_contact_id')).toBe(true);
    // Nothing in the plan creates a record.
    expect(attio.some((s) => s.kind === 'append')).toBe(false);
  });

  it('reads back after every write — a success response is not evidence', () => {
    const { steps } = planMint(cand, 'BHC-02531');
    for (const w of steps.filter((s) => s.kind !== 'read-back')) {
      const laterReadBack = steps.some(
        (s) => s.kind === 'read-back' && s.system === w.system && s.order > w.order,
      );
      expect(laterReadBack, `no read-back after step ${w.order} (${w.system})`).toBe(true);
    }
  });

  it('every step carries an assertion that says what aborts the mint', () => {
    for (const s of planMint(cand, 'BHC-02531').steps) {
      expect(s.assertion.length).toBeGreaterThan(20);
    }
  });

  it('refuses to guess a pairing when ids and candidates disagree', () => {
    expect(() => planBatch([cand], ['BHC-02531', 'BHC-02532'])).toThrow(/refusing to guess/i);
  });
});

// ─── CLAUSE: what must not be minted ─────────────────────────────────────────

describe('suppression is re-checked at mint time', () => {
  it('blocks a scrapped identity that Attio has re-created', () => {
    // MUTATION TARGET #3. Raymond Yang, scrapped 2026-08-05, re-created by
    // Attio's sync on 2026-08-30 and 2026-09-01. Removing the re-check mints
    // him a third time.
    const raymond = contact({
      attioRecordId: 'rec-raymond',
      name: 'Raymond Yang',
      primaryEmail: 'raymondy@thenewblank.com',
      allEmails: ['raymondy@thenewblank.com'],
    });
    const { candidates, blocked } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [raymond],
    });
    expect(candidates).toHaveLength(0);
    expect(blocked[0]!.reason).toBe('suppressed');
    expect(blocked[0]!.detail).toMatch(/SCRAPPED 2026-08-05/);
  });

  it('lets an unsuppressed contact through, so the block is not vacuous', () => {
    // Guards against the "decorative test" failure: if selectMintCandidates
    // blocked everything, the test above would pass for the wrong reason.
    const { candidates } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [contact({ attioRecordId: 'rec-ok', name: 'Tomas Kamphuis' })],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.contact.attioRecordId).toBe('rec-ok');
  });
});

describe('duplicate and typo candidates are never minted', () => {
  it('blocks a record flagged by the duplicate sweep', () => {
    // MUTATION TARGET #4. Removing the exclusion mints an ID onto a record
    // that is about to be merged — and bhc_contact_id may not survive it.
    const c = contact({ attioRecordId: 'rec-dupe', name: 'Lana Hougham' });
    const { candidates, blocked } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [c],
      duplicateFlagged: new Set(['rec-dupe']),
    });
    expect(candidates).toHaveLength(0);
    expect(blocked[0]!.reason).toBe('duplicate-candidate');
  });

  it('mints the same record once the duplicate flag is cleared', () => {
    // The negative case differs in EXACTLY ONE field from the positive one, so
    // the guard under test is the only thing that can change the outcome.
    const c = contact({ attioRecordId: 'rec-dupe', name: 'Lana Hougham' });
    const { candidates } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [c],
      duplicateFlagged: new Set<string>(),
    });
    expect(candidates).toHaveLength(1);
  });
});

describe('the remaining exclusions', () => {
  it('flags a no-email participant instead of creating a record', () => {
    const { candidates, blocked } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [contact({ attioRecordId: 'rec-noemail', primaryEmail: null, allEmails: [] })],
    });
    expect(candidates).toHaveLength(0);
    expect(blocked[0]!.reason).toBe('no-email');
  });

  it('refuses a record with no name to verify a stamp against', () => {
    const { blocked } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [contact({ attioRecordId: 'rec-noname', name: null })],
    });
    expect(blocked[0]!.reason).toBe('no-name');
  });

  it('skips a record that already carries a bhc_contact_id', () => {
    const { blocked } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts: [contact({ attioRecordId: 'rec-bridged' })],
      bridged: new Map([['rec-bridged', 'BHC-01234']]),
    });
    expect(blocked[0]!.reason).toBe('already-bridged');
    expect(blocked[0]!.detail).toMatch(/BHC-01234/);
  });

  it('accounts for every input record — nothing is silently dropped', () => {
    const contacts = [
      contact({ attioRecordId: 'a' }),
      contact({ attioRecordId: 'b', name: 'Raymond Yang' }),
      contact({ attioRecordId: 'c', primaryEmail: null, allEmails: [] }),
      contact({ attioRecordId: 'd' }),
    ];
    const { candidates, blocked } = selectMintCandidates({
      ...emptySelectionInput(),
      contacts,
      duplicateFlagged: new Set(['d']),
    });
    expect(candidates.length + blocked.length).toBe(contacts.length);
    expect(blockedByReason(blocked)).toMatchObject({
      suppressed: 1,
      'duplicate-candidate': 1,
      'no-email': 1,
    });
  });
});
