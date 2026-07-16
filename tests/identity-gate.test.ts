/**
 * The identity gate is the guardrail whose absence corrupted ~82 records in June.
 * These tests are the regression net for that class of bug: they assert that a
 * pointer we cannot verify never results in a write.
 */

import { describe, expect, it } from 'vitest';

import { verifyName } from '../src/lib/name-verify.js';
import { evaluateContact } from '../src/passes/pass4/index.js';
import type { MasterIdEntry, MasterIdIndex, TierIndex } from '../src/passes/pass4/load.js';
import type { AttioPersonRecord, AttioPipelineEntry } from '../src/lib/attio.js';
import type { CivilDate } from '../src/lib/dates.js';
import type { Tier } from '../src/config/constants.js';

const TODAY = '2026-07-15' as CivilDate;
const RECORD_ID = 'rec-aaa';

function masterIndex(entries: MasterIdEntry[], duplicates: string[] = []): MasterIdIndex {
  const byBhcId = new Map(entries.map((e) => [e.bhcId, e]));
  const byAttioRecordId = new Map(
    entries.filter((e) => e.attioRecordId !== '' && !duplicates.includes(e.attioRecordId)).map((e) => [e.attioRecordId, e]),
  );
  return { byBhcId, byAttioRecordId, duplicateAttioRecordIds: duplicates, rowCount: entries.length };
}

function tierIndex(pairs: Array<[string, Tier]> = []): TierIndex {
  return { byBhcId: new Map(pairs), headerTitle: 'Relationship_Tier', columnIndex: 21 };
}

function entry(stages: Partial<Record<'tnb_stage' | 'fractional_stage' | 'fte_stage', string>> = {}): AttioPipelineEntry {
  const entryValues: Record<string, unknown> = {};
  for (const [slug, title] of Object.entries(stages)) {
    entryValues[slug] = [{ option: { title } }];
  }
  return { entryId: 'ent-1', recordId: RECORD_ID, entryValues };
}

function person(opts: { name?: string; bhcContactId?: string; lastInteraction?: string }): AttioPersonRecord {
  const values: Record<string, unknown> = {};
  if (opts.name !== undefined) values['name'] = [{ full_name: opts.name }];
  if (opts.bhcContactId !== undefined) values['bhc_contact_id'] = [{ value: opts.bhcContactId }];
  if (opts.lastInteraction !== undefined) values['last_interaction_at'] = [{ value: opts.lastInteraction }];
  return { recordId: RECORD_ID, values };
}

const ALICE: MasterIdEntry = {
  bhcId: 'BHC-00001',
  fullName: 'Alice Nguyen',
  location: 'BOTH',
  googleRow: 365,
  attioRecordId: RECORD_ID,
  masterRow: 2,
};

describe('verifyName', () => {
  it('matches on at least one significant word', () => {
    expect(verifyName('Alice Nguyen', 'Alice Nguyen').verdict).toBe('MATCH');
    expect(verifyName('alice nguyen', 'Alice Nguyen').verdict).toBe('MATCH');
    expect(verifyName('Alice Nguyen-Smith', 'Alice Nguyen').verdict).toBe('MATCH');
    expect(verifyName('A. Nguyen', 'Alice Nguyen').verdict).toBe('MATCH');
    expect(verifyName('Nguyen, Alice', 'Alice Nguyen').verdict).toBe('MATCH');
  });

  it('rejects when zero significant words are shared', () => {
    expect(verifyName('Bo Bishop', 'Kwame Koka').verdict).toBe('MISMATCH');
  });

  it('does not let particles alone carry a match', () => {
    expect(verifyName('Ludwig van Beethoven', 'Vincent van Gogh').verdict).toBe('MISMATCH');
  });

  it('treats a missing name as unverifiable, never as a pass', () => {
    expect(verifyName(null, 'Alice Nguyen').verdict).toBe('UNVERIFIABLE');
    expect(verifyName('Alice Nguyen', '').verdict).toBe('UNVERIFIABLE');
    expect(verifyName('', '').verdict).toBe('UNVERIFIABLE');
    expect(verifyName('...', 'Alice Nguyen').verdict).toBe('UNVERIFIABLE');
  });
});

describe('evaluateContact — identity gate', () => {
  const master = masterIndex([ALICE]);
  const tiers = tierIndex([['BHC-00001', 'Core']]);

  it('clears a verified contact to write', () => {
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2 – Proposal' }),
      record: person({ name: 'Alice Nguyen', bhcContactId: 'BHC-00001', lastInteraction: '2026-07-13' }),
      master,
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBeNull();
    expect(row.nameVerdict).toBe('MATCH');
    expect(row.bhcId).toBe('BHC-00001');
    expect(row.nextCheckIn).toBe('2026-07-19');
  });

  it('withholds when Attio bhc_contact_id disagrees with Master_ID', () => {
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2' }),
      record: person({ name: 'Alice Nguyen', bhcContactId: 'BHC-09999', lastInteraction: '2026-07-13' }),
      master,
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBe('ATTIO_ID_MISMATCH');
    expect(row.notes.join(' ')).toMatch(/CADENCE_MISMATCH/);
  });

  it('withholds when the name does not match — the June failure class', () => {
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2' }),
      record: person({ name: 'Kwame Koka', bhcContactId: 'BHC-00001', lastInteraction: '2026-07-13' }),
      master,
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBe('NAME_MISMATCH');
    expect(row.notes.join(' ')).toMatch(/CADENCE-NAME-MISMATCH/);
  });

  it('withholds when the name cannot be verified', () => {
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2' }),
      record: person({ bhcContactId: 'BHC-00001', lastInteraction: '2026-07-13' }),
      master,
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBe('NAME_UNVERIFIABLE');
  });

  it('withholds when two Master_ID rows claim the same Attio record', () => {
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2' }),
      record: person({ name: 'Alice Nguyen', bhcContactId: 'BHC-00001' }),
      master: masterIndex([ALICE], [RECORD_ID]),
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBe('MASTER_ID_DUPLICATE_POINTER');
  });

  it('withholds when the person record could not be fetched', () => {
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2' }),
      record: null,
      master,
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBe('FETCH_FAILED');
  });

  it('passes a record with no bhc_contact_id set, provided the name matches', () => {
    // A blank bhc_contact_id is an un-backfilled record, not a wrong pointer.
    const row = evaluateContact({
      entry: entry({ tnb_stage: 'Stage 2' }),
      record: person({ name: 'Alice Nguyen', lastInteraction: '2026-07-13' }),
      master,
      tiers,
      today: TODAY,
    });
    expect(row.withheld).toBeNull();
  });
});

describe('evaluateContact — tier resolution', () => {
  it('uses the Google tier index when present', () => {
    const row = evaluateContact({
      entry: entry(),
      record: person({ name: 'Alice Nguyen', bhcContactId: 'BHC-00001', lastInteraction: '2026-07-01' }),
      master: masterIndex([ALICE]),
      tiers: tierIndex([['BHC-00001', 'Peripheral']]),
      today: TODAY,
    });
    expect(row.tier).toBe('Peripheral');
    expect(row.cadenceDays).toBe(180);
    expect(row.tierDefaulted).toBe(false);
  });

  it('defaults to Strategic and flags it when the contact has no tier', () => {
    const row = evaluateContact({
      entry: entry(),
      record: person({ name: 'Alice Nguyen', bhcContactId: 'BHC-00001', lastInteraction: '2026-07-01' }),
      master: masterIndex([ALICE]),
      tiers: tierIndex([]),
      today: TODAY,
    });
    expect(row.tier).toBe('Strategic');
    expect(row.tierDefaulted).toBe(true);
    expect(row.notes.join(' ')).toMatch(/defaulted to Strategic/);
  });

  it('proceeds with the default tier for a record absent from Master_ID', () => {
    const row = evaluateContact({
      entry: entry(),
      record: person({ name: 'Someone New', lastInteraction: '2026-07-01' }),
      master: masterIndex([]),
      tiers: tierIndex([]),
      today: TODAY,
    });
    expect(row.bhcId).toBeNull();
    expect(row.withheld).toBeNull();
    expect(row.tier).toBe('Strategic');
    expect(row.notes.join(' ')).toMatch(/no Master_ID row maps this Attio record/);
  });
});
