import { describe, expect, it } from 'vitest';

import { columnLetter, loadMasterId } from '../src/passes/pass4/load.js';
import { SheetsClient } from '../src/lib/sheets.js';
import { FakeBackend } from './helpers/fake-backend.js';

describe('columnLetter', () => {
  it('maps 0-based indices to A1 column letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(21)).toBe('V');
    expect(columnLetter(24)).toBe('Y'); // Relationship_Tier, per the real sheet
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(112)).toBe('DI'); // last column of the 113-wide header
    expect(columnLetter(155)).toBe('EZ'); // end of the widened read range
  });
});

// ─── Empty-index guard ────────────────────────────────────────────────────────
//
// An empty Master_ID index is indistinguishable, downstream, from a Master_ID
// that simply doesn't contain the contact being looked up: every identity gate
// takes its `if (!entry)` branch, withholds, and the run reports a clean zero.
// That is the exact shape of the 2026-08-15 silent-withhold defect, so an
// empty index is a stop condition rather than a state to propagate.

describe('loadMasterId — empty index', () => {
  it('throws rather than returning an index that would withhold every write', async () => {
    const backend = new FakeBackend({
      entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [],
    });
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });

    await expect(loadMasterId(sheets)).rejects.toThrow(/Master_ID loaded 0 entries/);
    await backend.stop();
  });

  it('is satisfied by a single row — the guard is about zero, not about size', async () => {
    const backend = new FakeBackend({
      entries: [], people: {}, masterId: [['BHC-00001', 'Only Row', 'ATTIO', '', 'rec-1', '']],
      contactsHeader: [], contacts: [],
    });
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });

    const index = await loadMasterId(sheets);
    await backend.stop();
    expect(index.rowCount).toBe(1);
  });
});
