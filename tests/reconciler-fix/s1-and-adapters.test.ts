import { describe, expect, it } from 'vitest';

import { groupByDuplicateBhcId } from '../../src/passes/reconciler-fix/canonical.js';
import { repairS1, s1DuplicateNote, type S1Row } from '../../src/passes/reconciler-fix/s1.js';
import type { Logger, MasterSheetPort } from '../../src/passes/reconciler-fix/ports.js';

const silent: Logger = { info: () => {}, warn: () => {} };

class FakeSheet implements MasterSheetPort {
  cells = new Map<string, string>();
  updates: { range: string; value: string }[] = [];
  constructor(rows: { row: number; a: string }[]) {
    for (const r of rows) for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) this.cells.set(`${c}${r.row}`, c === 'A' ? r.a : '');
  }
  private key(range: string) { const m = /Master_ID!([A-F])(\d+)/.exec(range)!; return `${m[1]}${m[2]}`; }
  async read(range: string) { return [[this.cells.get(this.key(range)) ?? '']]; }
  async update(range: string, values: unknown[][]) {
    const k = this.key(range); const v = String(values[0]?.[0] ?? '');
    this.updates.push({ range: k, value: v }); this.cells.set(k, v); return {};
  }
  columnsWritten() { return [...new Set(this.updates.map((u) => u.range[0]))].sort(); }
}

const row = (o: Partial<S1Row> = {}): S1Row =>
  ({ masterRow: 10, bhcId: 'BHC-1', fullName: 'Ada Lovelace', location: 'BOTH', googleRow: 100, attioRecordId: 'rec-1', ...o });

const deps = (sheet: FakeSheet) => ({ sheets: sheet, logger: silent, fixRunId: 'RECON-FIX-1' });

describe('groupByDuplicateBhcId - a different key from S4 grouping', () => {
  it('groups two or more rows sharing a populated BHC_ID', () => {
    const g = groupByDuplicateBhcId([row({ masterRow: 10 }), row({ masterRow: 20 }), row({ masterRow: 30, bhcId: 'BHC-2' })]);
    expect([...g.keys()]).toEqual(['BHC-1']);
  });

  it('a BLANK BHC_ID is never a duplicate - that is S2 (missing anchor), not S1', () => {
    const g = groupByDuplicateBhcId([row({ masterRow: 10, bhcId: '' }), row({ masterRow: 20, bhcId: '' })]);
    expect(g.size).toBe(0);
  });

  it('keys on BHC_ID, NOT the Attio pointer - rows sharing a pointer are S4, not S1', () => {
    const g = groupByDuplicateBhcId([
      row({ masterRow: 10, bhcId: 'BHC-1', attioRecordId: 'rec-shared' }),
      row({ masterRow: 20, bhcId: 'BHC-2', attioRecordId: 'rec-shared' }),
    ]);
    expect(g.size).toBe(0);
  });
});

describe('S1 - flag and stop, never resolve', () => {
  const dupes = () => [
    row({ masterRow: 10, bhcId: 'BHC-1', fullName: 'Ada Lovelace', googleRow: 100, attioRecordId: 'rec-1' }),
    row({ masterRow: 20, bhcId: 'BHC-1', fullName: 'Ada L', googleRow: null, attioRecordId: '' }),
  ];

  it('writes ONLY column F - never C, D, or E, and never A', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'BHC-1' }]);
    await repairS1(dupes(), deps(sheet));
    expect(sheet.columnsWritten()).toEqual(['F']);
  });

  it('flags the orphan and leaves the canonical entirely alone', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'BHC-1' }]);
    const r = await repairS1(dupes(), deps(sheet));
    expect(r.groups[0]!.canonicalRow).toBe(10);   // scores 4
    expect(r.groups[0]!.orphansFlagged).toEqual([20]);
    expect(sheet.cells.get('F20')).toContain('S1-DUPLICATE');
    expect(sheet.cells.get('F10')).toBe('');      // canonical untouched
  });

  it('the BHC_ID itself is never altered', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'BHC-1' }]);
    await repairS1(dupes(), deps(sheet));
    expect(sheet.cells.get('A10')).toBe('BHC-1');
    expect(sheet.cells.get('A20')).toBe('BHC-1');
  });

  it('names the canonical by NAME, not BHC_ID - both rows share the same ID', async () => {
    const note = s1DuplicateNote('BHC-1', 'Ada Lovelace', 'RECON-FIX-1');
    expect(note).toContain('also appears on the row for Ada Lovelace');
    expect(note).toContain('Notes only');
    expect(note).not.toMatch(/\brow \d+/); // non-negotiable 6b
  });

  it('falls back gracefully when the canonical has no name', () => {
    expect(s1DuplicateNote('BHC-1', '   ', 'RECON-FIX-1')).toContain('(unnamed row)');
  });

  it('a SUPERSEDED row is never flagged as a duplicate', async () => {
    // Non-negotiable 6c: a retirement retains its BHC_ID by design, so it looks
    // like a duplicate and must be excluded before scoring.
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 962, a: 'BHC-1' }]);
    const r = await repairS1([
      row({ masterRow: 10, bhcId: 'BHC-1' }),
      row({ masterRow: 962, bhcId: 'BHC-1', location: 'SUPERSEDED', googleRow: null, attioRecordId: '' }),
    ], deps(sheet));

    expect(r.groups[0]!.outcome).toBe('nothing_to_do');
    expect(sheet.updates).toHaveLength(0);
    expect(sheet.cells.get('F962')).toBe('');
  });

  it('flags every orphan in a three-way duplicate', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'BHC-1' }, { row: 30, a: 'BHC-1' }]);
    const r = await repairS1([
      row({ masterRow: 10, googleRow: 100, attioRecordId: 'rec-1' }),
      row({ masterRow: 20, googleRow: null, attioRecordId: '' }),
      row({ masterRow: 30, googleRow: null, attioRecordId: '' }),
    ], deps(sheet));
    expect(r.counts.orphansFlagged).toBe(2);
    expect(r.groups[0]!.orphansFlagged).toEqual([20, 30]);
  });

  it('a hard stop on one orphan does not stop the next', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'WRONG' }, { row: 30, a: 'BHC-1' }]);
    const r = await repairS1([
      row({ masterRow: 10, googleRow: 100, attioRecordId: 'rec-1' }),
      row({ masterRow: 20, googleRow: null, attioRecordId: '' }),
      row({ masterRow: 30, googleRow: null, attioRecordId: '' }),
    ], deps(sheet));
    expect(r.counts.hardStops).toBe(1);
    expect(r.groups[0]!.orphansFlagged).toEqual([30]);
  });

  it('does nothing at all when no BHC_ID is duplicated', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'BHC-2' }]);
    const r = await repairS1([row({ masterRow: 10, bhcId: 'BHC-1' }), row({ masterRow: 20, bhcId: 'BHC-2' })], deps(sheet));
    expect(r.counts.groups).toBe(0);
    expect(sheet.updates).toHaveLength(0);
  });
});

describe('adapters expose ONLY the port surface', async () => {
  const { makeAttioIdentityWritePort, makeAttioReadPort, makeMasterSheetPort } = await import('../../src/passes/reconciler-fix/adapters.js');

  it('the Master_ID port has exactly read + update', () => {
    const p = makeMasterSheetPort({} as never);
    expect(Object.keys(p).sort()).toEqual(['read', 'update']);
  });

  it('the read-only Attio port has NO write method', () => {
    const p = makeAttioReadPort({} as never);
    expect(Object.keys(p).sort()).toEqual(['getByRecordId', 'queryByBhcContactId']);
    expect('updatePerson' in p).toBe(false);
  });

  it('the write port exposes exactly one write, and no path back to the client', () => {
    const p = makeAttioIdentityWritePort({ marker: 'the-real-client' } as never);
    expect(Object.keys(p).sort()).toEqual(['getByRecordId', 'queryByBhcContactId', 'queryByEmail', 'updatePerson']);
    // The wide client is captured in a closure, not reachable from the adapter.
    expect(JSON.stringify(p)).not.toContain('the-real-client');
    expect(Object.values(p).some((v) => typeof v !== 'function')).toBe(false);
  });
});
