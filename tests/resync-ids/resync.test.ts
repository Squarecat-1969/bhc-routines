import { describe, expect, it } from 'vitest';

import { buildContactsIndex, computeResync, formatSlackMessage } from '../../src/passes/resync-ids/resync.js';
import type { MasterIdRowLite } from '../../src/passes/resync-ids/types.js';

function m(o: Partial<MasterIdRowLite> = {}): MasterIdRowLite {
  return { bhcId: 'BHC-1', location: 'BOTH', storedGoogleRow: 10, masterRow: 2, ...o };
}
/** Contacts col A as the API returns it, starting at sheet row 3. */
function contacts(ids: readonly string[]) {
  return buildContactsIndex(ids.map((id) => [id]));
}

describe('buildContactsIndex', () => {
  it('maps ids to real sheet rows starting at 3 — row 2 is the ARRAYFORMULA spill', () => {
    const { index } = contacts(['BHC-1', 'BHC-2', 'BHC-3']);
    expect(index.get('BHC-1')).toBe(3);
    expect(index.get('BHC-3')).toBe(5);
  });

  it('skips blank cells without consuming a row number', () => {
    const { index } = contacts(['BHC-1', '', 'BHC-3']);
    expect(index.get('BHC-3')).toBe(5); // still its true row, gap included
    expect(index.has('')).toBe(false);
  });

  it('records a repeated Contact_ID as ambiguous rather than first-wins', () => {
    const { index, duplicates } = contacts(['BHC-1', 'BHC-2', 'BHC-1']);
    expect(duplicates.has('BHC-1')).toBe(true);
    expect(index.get('BHC-1')).toBe(3); // recorded, but the caller must not use it
  });

  it('trims whitespace around a stored id', () => {
    const { index } = contacts([' BHC-1 ']);
    expect(index.get('BHC-1')).toBe(3);
  });
});

describe('computeResync — the four outcomes', () => {
  it('CORRECTS a pointer that has drifted', () => {
    const plan = computeResync([m({ bhcId: 'BHC-2', storedGoogleRow: 99 })], contacts(['BHC-1', 'BHC-2']));
    expect(plan.corrections).toEqual([{ bhcId: 'BHC-2', masterRow: 2, oldRow: 99, newRow: 4 }]);
  });

  it('NO-OPS a pointer that is already right — no write is issued', () => {
    const plan = computeResync([m({ bhcId: 'BHC-1', storedGoogleRow: 3 })], contacts(['BHC-1']));
    expect(plan.corrections).toHaveLength(0);
    expect(plan.alreadyCorrect).toBe(1);
  });

  it('leaves a contact MISSING from Contacts untouched — Reconciler\'s finding, not ours to guess', () => {
    const plan = computeResync([m({ bhcId: 'BHC-GONE', storedGoogleRow: 50 })], contacts(['BHC-1']));
    expect(plan.corrections).toHaveLength(0);
    expect(plan.unresolvable).toHaveLength(1);
    expect(plan.unresolvable[0]!.reason).toBe('not_in_contacts');
  });

  it('refuses to choose when a Contact_ID is duplicated in Contacts', () => {
    const plan = computeResync([m({ bhcId: 'BHC-1', storedGoogleRow: 99 })], contacts(['BHC-1', 'BHC-1']));
    expect(plan.corrections).toHaveLength(0);
    expect(plan.unresolvable[0]!.reason).toBe('duplicate_in_contacts');
  });

  it('fills a BLANK stored pointer when the contact really is there', () => {
    const plan = computeResync([m({ bhcId: 'BHC-1', storedGoogleRow: null })], contacts(['BHC-1']));
    expect(plan.corrections[0]).toMatchObject({ oldRow: null, newRow: 3 });
  });
});

describe('computeResync — what it must never touch', () => {
  it('skips SUPERSEDED on the LOCATION FIELD ALONE, never inferred from blank pointers', () => {
    const plan = computeResync(
      [m({ bhcId: 'BHC-OLD', location: 'SUPERSEDED', storedGoogleRow: null })],
      contacts(['BHC-OLD']),
    );
    expect(plan.skippedSuperseded).toBe(1);
    expect(plan.corrections).toHaveLength(0);
    expect(plan.checked).toBe(0);
  });

  it('STILL flags a damaged GOOGLE row with a blank pointer — the row-962 case', () => {
    // BHC-00920 is a real damaged row: blank pointers, Location still GOOGLE.
    // Treating "blank" as "retired" would silently swallow exactly this.
    const plan = computeResync(
      [m({ bhcId: 'BHC-00920', location: 'GOOGLE', storedGoogleRow: null })],
      contacts(['BHC-00920']),
    );
    expect(plan.skippedSuperseded).toBe(0);
    expect(plan.corrections).toHaveLength(1); // repaired, not skipped
  });

  it('ignores ATTIO-only identities — they have no Google row to derive', () => {
    const plan = computeResync([m({ location: 'ATTIO' })], contacts(['BHC-1']));
    expect(plan.skippedNotGoogle).toBe(1);
    expect(plan.checked).toBe(0);
  });

  it('skips fully-blank gap rows', () => {
    const plan = computeResync([m({ bhcId: '', location: '' })], contacts(['BHC-1']));
    expect(plan.skippedGapRows).toBe(1);
  });

  it('handles a realistic mix and counts every category independently', () => {
    const plan = computeResync(
      [
        m({ bhcId: 'BHC-1', location: 'BOTH', storedGoogleRow: 3, masterRow: 2 }),   // correct
        m({ bhcId: 'BHC-2', location: 'GOOGLE', storedGoogleRow: 99, masterRow: 3 }), // drifted
        m({ bhcId: 'BHC-3', location: 'SUPERSEDED', storedGoogleRow: null, masterRow: 4 }),
        m({ bhcId: 'BHC-4', location: 'ATTIO', storedGoogleRow: null, masterRow: 5 }),
        m({ bhcId: 'BHC-5', location: 'BOTH', storedGoogleRow: 7, masterRow: 6 }),   // missing
        m({ bhcId: '', location: '', storedGoogleRow: null, masterRow: 7 }),
      ],
      contacts(['BHC-1', 'BHC-2']),
    );
    expect(plan).toMatchObject({
      checked: 3, alreadyCorrect: 1, skippedSuperseded: 1, skippedNotGoogle: 1, skippedGapRows: 1,
    });
    expect(plan.corrections.map((c) => c.bhcId)).toEqual(['BHC-2']);
    expect(plan.unresolvable.map((u) => u.bhcId)).toEqual(['BHC-5']);
  });
});

describe('formatSlackMessage', () => {
  it('names each correction with old and new row', () => {
    const plan = computeResync([m({ bhcId: 'BHC-2', storedGoogleRow: 99 })], contacts(['BHC-1', 'BHC-2']));
    const msg = formatSlackMessage(plan, { dryRun: false, runId: 'RESYNC-1' });
    expect(msg).toContain('BHC-2 — Google_Row 99 → 4');
    expect(msg).toContain('1 correction(s)');
  });

  it('says so plainly when nothing needs fixing', () => {
    const plan = computeResync([m({ storedGoogleRow: 3 })], contacts(['BHC-1']));
    expect(formatSlackMessage(plan, { dryRun: false, runId: 'R' })).toContain('All Google_Row pointers already correct.');
  });

  it('marks a dry run as having written nothing', () => {
    const plan = computeResync([m({ storedGoogleRow: 99 })], contacts(['BHC-1']));
    expect(formatSlackMessage(plan, { dryRun: true, runId: 'R' })).toContain('DRY RUN — nothing written');
  });
});
