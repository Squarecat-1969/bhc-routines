import { describe, expect, it } from 'vitest';

import { repairA3, type A3Candidate } from '../../src/passes/reconciler-fix/a3.js';
import { repairS4, s4OrphanNote, type S4Row } from '../../src/passes/reconciler-fix/s4.js';
import { writeMasterCell } from '../../src/passes/reconciler-fix/master-write.js';
import type { AttioPerson, AttioReadPort, Logger, MasterSheetPort } from '../../src/passes/reconciler-fix/ports.js';

const silent: Logger = { info: () => {}, warn: () => {} };

/**
 * A fake Master_ID. Cells are keyed "C10", "E10"... Every update is recorded so
 * a test can assert not just the end state but exactly which cells were touched
 * — which is how the col-A tests prove a forbidden write never happened.
 */
class FakeSheet implements MasterSheetPort {
  cells = new Map<string, string>();
  updates: { range: string; value: string }[] = [];
  /** Cell key -> value to force into col A after the next write (corruption sim). */
  corruptColAAfterWrite: { key: string; value: string } | null = null;
  /** Same, but armed only when a specific cell is written - lets a test aim the
   *  corruption at the C-write rather than the E-write that comes before it. */
  corruptColAOnWriteTo: { trigger: string; key: string; value: string } | null = null;
  failReadbackFor = new Set<string>();

  constructor(rows: { row: number; a: string; c?: string; e?: string; f?: string }[]) {
    for (const r of rows) {
      this.cells.set(`A${r.row}`, r.a);
      this.cells.set(`C${r.row}`, r.c ?? '');
      this.cells.set(`E${r.row}`, r.e ?? '');
      this.cells.set(`F${r.row}`, r.f ?? '');
    }
  }
  private key(range: string): string {
    const m = /Master_ID!([A-F])(\d+)/.exec(range)!;
    return `${m[1]}${m[2]}`;
  }
  async read(range: string) { return [[this.cells.get(this.key(range)) ?? '']]; }
  async update(range: string, values: unknown[][]) {
    const k = this.key(range);
    const v = String(values[0]?.[0] ?? '');
    this.updates.push({ range: k, value: v });
    this.cells.set(k, this.failReadbackFor.has(k) ? 'NOT-WHAT-WAS-WRITTEN' : v);
    if (this.corruptColAAfterWrite) {
      this.cells.set(this.corruptColAAfterWrite.key, this.corruptColAAfterWrite.value);
      this.corruptColAAfterWrite = null;
    }
    if (this.corruptColAOnWriteTo && this.corruptColAOnWriteTo.trigger === k) {
      this.cells.set(this.corruptColAOnWriteTo.key, this.corruptColAOnWriteTo.value);
      this.corruptColAOnWriteTo = null;
    }
    return {};
  }
  colAWrites() { return this.updates.filter((u) => u.range.startsWith('A')); }
}

class FakeAttio implements AttioReadPort {
  constructor(
    private byBhc: Record<string, AttioPerson[]> = {},
    private byRecord: Record<string, AttioPerson | null> = {},
    private throwOn: { query?: boolean; get?: boolean } = {},
  ) {}
  async queryByBhcContactId(bhcId: string) {
    if (this.throwOn.query) throw new Error('attio 500');
    return this.byBhc[bhcId] ?? [];
  }
  async getByRecordId(recordId: string) {
    if (this.throwOn.get) throw new Error('attio 500');
    return this.byRecord[recordId] ?? null;
  }
}

const person = (o: Partial<AttioPerson> = {}): AttioPerson =>
  ({ recordId: 'rec-1', bhcContactId: 'BHC-1', name: 'Ada Lovelace', ...o });

const s4row = (o: Partial<S4Row> = {}): S4Row =>
  ({ masterRow: 10, bhcId: 'BHC-1', fullName: 'Ada Lovelace', location: 'BOTH', googleRow: 100, attioRecordId: 'rec-1', ...o });

// ════════════════════════════════════════════════════════════════════════════
// BUG-SHAPED SCENARIOS FIRST (acceptance 3) — designed to catch a mistake,
// asserted before any happy path is claimed to work.
// ════════════════════════════════════════════════════════════════════════════
describe('BUG-SHAPED: col A must never be written, and a change is a hard stop', () => {
  it('col A CHANGING mid-write is a hard stop for that row, and no note is written', () => {
    // Simulates the PASS 7 nightmare: something alters a BHC_ID during the run.
    // "the one failure here that cannot be undone by re-running."
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', e: 'rec-1', location: '' } as never]);
    sheet.corruptColAAfterWrite = { key: 'A10', value: 'BHC-999' };
    return writeMasterCell(sheet, silent, { masterRow: 10, column: 'E', value: '', expectedBhcId: 'BHC-1' })
      .then((r) => {
        expect(r.outcome).toBe('col_a_changed');
        expect(r.detail).toContain('CHANGED');
      });
  });

  it('refuses to write at all when col A already disagrees BEFORE the write', () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-SOMEONE-ELSE', e: 'rec-1' }]);
    return writeMasterCell(sheet, silent, { masterRow: 10, column: 'E', value: '', expectedBhcId: 'BHC-1' })
      .then((r) => {
        expect(r.outcome).toBe('col_a_changed');
        expect(sheet.updates).toHaveLength(0); // nothing was written
      });
  });

  it('a full S4 repair NEVER issues a write to col A, B or D', async () => {
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
      { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-shared' },
    ]);
    const attio = new FakeAttio({}, { 'rec-shared': person({ bhcContactId: 'BHC-1', name: 'Ada Lovelace' }) });
    await repairS4(
      [s4row({ masterRow: 10, bhcId: 'BHC-1' }), s4row({ masterRow: 20, bhcId: 'BHC-2', fullName: 'Bob Other' })],
      { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' },
    );
    expect(sheet.colAWrites()).toHaveLength(0);
    expect(sheet.updates.every((u) => /^[CEF]/.test(u.range))).toBe(true);
  });
});

describe('BUG-SHAPED: A3 with MULTIPLE results must never guess', () => {
  it('writes NOTHING to Location or the pointer when two records match', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-dead' }]);
    const attio = new FakeAttio({ 'BHC-1': [person({ recordId: 'rec-a' }), person({ recordId: 'rec-b' })] });
    const r = await repairA3([cand()], { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' });

    expect(r.rows[0]!.outcome).toBe('ambiguous');
    expect(r.rows[0]!.matchCount).toBe(2);
    expect(sheet.cells.get('C10')).toBe('BOTH');     // Location untouched
    expect(sheet.cells.get('E10')).toBe('rec-dead'); // pointer untouched
    expect(sheet.updates.map((u) => u.range)).toEqual(['F10']); // note only
    expect(sheet.cells.get('F10')).toContain('A3-AMBIGUOUS: 2 Attio records found');
  });
});

describe('BUG-SHAPED: a failed QA read-back logs and continues, never crashes', () => {
  it('reports readback_mismatch and does NOT write the note describing it', async () => {
    // Note discipline 1: never emit a note describing an action that was not
    // performed AND verified. Four live rows already claim a clear that never
    // happened; this is the guard against a fifth.
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-dead' }]);
    sheet.failReadbackFor.add('E10');
    const attio = new FakeAttio({ 'BHC-1': [person({ recordId: 'rec-new' })] });
    const r = await repairA3([cand()], { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' });

    expect(r.rows[0]!.outcome).toBe('write_failed');
    expect(sheet.cells.get('F10')).toBe(''); // no note claiming a repoint
  });

  it('one bad row does not abort the others (non-negotiable 5)', async () => {
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-dead' },
      { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-dead2' },
    ]);
    sheet.failReadbackFor.add('E10');
    const attio = new FakeAttio({ 'BHC-1': [person({ recordId: 'rec-x' })], 'BHC-2': [person({ recordId: 'rec-y' })] });
    const r = await repairA3(
      [cand(), cand({ masterRow: 20, bhcId: 'BHC-2', attioRecordId: 'rec-dead2' })],
      { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' },
    );
    expect(r.rows.map((x) => x.outcome)).toEqual(['write_failed', 'repointed']);
    expect(r.counts.repointed).toBe(1);
  });

  it('an Attio lookup failure is outcome D, not a crash', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', e: 'rec-dead' }]);
    const attio = new FakeAttio({}, {}, { query: true });
    const r = await repairA3([cand()], { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' });
    expect(r.rows[0]!.outcome).toBe('lookup_failed');
    expect(sheet.updates).toHaveLength(0);
  });
});

function cand(o: Partial<A3Candidate> = {}): A3Candidate {
  return { masterRow: 10, bhcId: 'BHC-1', fullName: 'Ada Lovelace', location: 'BOTH', attioRecordId: 'rec-dead', ...o };
}

// ════════════════════════════════════════════════════════════════════════════
// A3 — the three result branches
// ════════════════════════════════════════════════════════════════════════════
describe('A3 - Outcome A: exactly one record, repoint col E', () => {
  it('writes the live record id and a note referencing BHC_ID, not a row', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-dead' }]);
    const attio = new FakeAttio({ 'BHC-1': [person({ recordId: 'rec-live' })] });
    const r = await repairA3([cand()], { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' });

    expect(r.rows[0]!.outcome).toBe('repointed');
    expect(sheet.cells.get('E10')).toBe('rec-live');
    expect(sheet.cells.get('C10')).toBe('BOTH'); // Location NOT changed on outcome A
    expect(sheet.cells.get('F10')).toContain('A3-FIXED: Attio record_id updated from rec-dead to rec-live');
    expect(sheet.cells.get('F10')).not.toMatch(/\brow \d+/); // non-negotiable 6b
  });
});

describe('A3 - Outcome B: zero records, Google-only', () => {
  it('sets Location GOOGLE, clears the pointer, then notes it', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-dead' }]);
    const r = await repairA3([cand()], { sheets: sheet, attio: new FakeAttio(), logger: silent, fixRunId: 'RECON-FIX-1' });

    expect(r.rows[0]!.outcome).toBe('set_google_only');
    expect(sheet.cells.get('C10')).toBe('GOOGLE');
    expect(sheet.cells.get('E10')).toBe('');
    expect(sheet.cells.get('F10')).toContain('no Attio record found');
    // The note is written LAST, after both writes verified.
    expect(sheet.updates.map((u) => u.range)).toEqual(['C10', 'E10', 'F10']);
  });
});

describe('A3 - a SUPERSEDED row is skipped entirely', () => {
  it('writes nothing, per non-negotiable 6c', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1', c: 'SUPERSEDED' }]);
    const r = await repairA3([cand({ location: 'SUPERSEDED' })], { sheets: sheet, attio: new FakeAttio(), logger: silent, fixRunId: 'RECON-FIX-1' });
    expect(r.rows[0]!.outcome).toBe('skipped_superseded');
    expect(sheet.updates).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S4
// ════════════════════════════════════════════════════════════════════════════
describe('S4 - orphan clearing', () => {
  const shared = { attioRecordId: 'rec-shared' };

  it('clears the orphan, leaves the canonical untouched, verifies the clear', async () => {
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
      { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-shared' },
    ]);
    const attio = new FakeAttio({}, { 'rec-shared': person({ bhcContactId: 'BHC-1', name: 'Ada Lovelace' }) });
    const r = await repairS4(
      [s4row({ masterRow: 10, bhcId: 'BHC-1', ...shared }), s4row({ masterRow: 20, bhcId: 'BHC-2', fullName: 'Bob Other', ...shared })],
      { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' },
    );

    expect(r.counts.orphansCleared).toBe(1);
    expect(sheet.cells.get('E10')).toBe('rec-shared'); // canonical untouched
    expect(sheet.cells.get('E20')).toBe('');           // orphan cleared
    expect(sheet.cells.get('C20')).toBe('GOOGLE');
    expect(sheet.cells.get('F20')).toContain('S4-ORPHAN');
    expect(sheet.cells.get('F10')).toBe('');           // canonical gets no note
  });

  it('Attio evidence OVERRIDES scoring when the score-winner is not the true owner', async () => {
    // Row 10 scores higher (lower row, both pointers) but Attio says the record
    // belongs to BHC-2. Clearing BHC-2 would strip the true owner's pointer.
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
      { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-shared' },
    ]);
    const attio = new FakeAttio({}, { 'rec-shared': person({ bhcContactId: 'BHC-2', name: 'Bob Other' }) });
    const r = await repairS4(
      [s4row({ masterRow: 10, bhcId: 'BHC-1', ...shared }), s4row({ masterRow: 20, bhcId: 'BHC-2', fullName: 'Bob Other', ...shared })],
      { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' },
    );

    expect(r.groups[0]!.canonicalBhcId).toBe('BHC-2');
    expect(r.groups[0]!.canonicalFromAttio).toBe(true);
    expect(sheet.cells.get('E20')).toBe('rec-shared'); // true owner keeps it
    expect(sheet.cells.get('E10')).toBe('');           // score-winner cleared
  });

  it('NEEDS_MANUAL when neither BHC_ID nor name matches the Attio person', async () => {
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
      { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-shared' },
    ]);
    const attio = new FakeAttio({}, { 'rec-shared': person({ bhcContactId: 'BHC-999', name: 'Someone Entirely Else' }) });
    const r = await repairS4(
      [s4row({ masterRow: 10, bhcId: 'BHC-1', ...shared }), s4row({ masterRow: 20, bhcId: 'BHC-2', fullName: 'Bob Other', ...shared })],
      { sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' },
    );
    expect(r.groups[0]!.outcome).toBe('needs_manual');
    expect(sheet.updates).toHaveLength(0); // nothing written for the whole group
  });

  it('a dead pointer is an A3 condition, not an S4 repair - writes nothing', async () => {
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', e: 'rec-gone' },
      { row: 20, a: 'BHC-2', e: 'rec-gone' },
    ]);
    const r = await repairS4(
      [s4row({ masterRow: 10, bhcId: 'BHC-1', attioRecordId: 'rec-gone' }), s4row({ masterRow: 20, bhcId: 'BHC-2', attioRecordId: 'rec-gone' })],
      { sheets: sheet, attio: new FakeAttio(), logger: silent, fixRunId: 'RECON-FIX-1' },
    );
    expect(r.groups[0]!.outcome).toBe('needs_manual');
    expect(sheet.updates).toHaveLength(0);
  });

  it('a blank Attio_Record_ID never forms a group - the 245-row trap', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }, { row: 20, a: 'BHC-2' }]);
    const r = await repairS4(
      [s4row({ masterRow: 10, bhcId: 'BHC-1', attioRecordId: '' }), s4row({ masterRow: 20, bhcId: 'BHC-2', attioRecordId: '' })],
      { sheets: sheet, attio: new FakeAttio(), logger: silent, fixRunId: 'RECON-FIX-1' },
    );
    expect(r.counts.groups).toBe(0);
    expect(sheet.updates).toHaveLength(0);
  });

  // A HALF-APPLIED REPAIR IS THE ONE OUTCOME THIS THREE-COLUMN WRITE EXISTS TO
  // PREVENT. If the pointer clears but Location stays BOTH/ATTIO, the row is
  // left in exactly the S3 shape S4 was repairing - and the note would claim
  // "Pointer cleared" over it. Mirrors the E-clear read-back test, for the
  // C-write step.
  const twoRowGroup = () => new FakeSheet([
    { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
    { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-shared' },
  ]);
  const groupRows = () => [
    s4row({ masterRow: 10, bhcId: 'BHC-1', attioRecordId: 'rec-shared' }),
    s4row({ masterRow: 20, bhcId: 'BHC-2', fullName: 'Bob Other', attioRecordId: 'rec-shared' }),
  ];
  const ownedByBhc1 = () => new FakeAttio({}, { 'rec-shared': person({ bhcContactId: 'BHC-1', name: 'Ada Lovelace' }) });

  it('Location write FAILING read-back after a successful E-clear: no note, not counted as cleared', async () => {
    const sheet = twoRowGroup();
    sheet.failReadbackFor.add('C20');
    const r = await repairS4(groupRows(), { sheets: sheet, attio: ownedByBhc1(), logger: silent, fixRunId: 'RECON-FIX-1' });

    expect(sheet.cells.get('E20')).toBe('');          // the clear did land
    expect(sheet.cells.get('F20')).toBe('');          // but NO note claiming it
    expect(r.groups[0]!.orphansCleared).toEqual([]);  // and not counted as cleared
    expect(r.counts.orphansCleared).toBe(0);
    expect(sheet.updates.map((u) => u.range)).toEqual(['E20', 'C20']); // stopped before F
  });

  it('Location write HARD-STOPPING after a successful E-clear: no note, not counted as cleared', async () => {
    const sheet = twoRowGroup();
    sheet.corruptColAOnWriteTo = { trigger: 'C20', key: 'A20', value: 'BHC-999' };
    const r = await repairS4(groupRows(), { sheets: sheet, attio: ownedByBhc1(), logger: silent, fixRunId: 'RECON-FIX-1' });

    expect(r.groups[0]!.writes.some((w) => w.outcome === 'col_a_changed')).toBe(true);
    expect(sheet.cells.get('F20')).toBe('');
    expect(r.groups[0]!.orphansCleared).toEqual([]);
    expect(r.counts.hardStops).toBe(1);
  });

  it('a Location failure on one orphan does not stop the next (non-negotiable 5)', async () => {
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
      { row: 20, a: 'BHC-2', c: 'BOTH', e: 'rec-shared' },
      { row: 30, a: 'BHC-3', c: 'BOTH', e: 'rec-shared' },
    ]);
    sheet.failReadbackFor.add('C20');
    const r = await repairS4(
      [...groupRows(), s4row({ masterRow: 30, bhcId: 'BHC-3', fullName: 'Cy Rand', attioRecordId: 'rec-shared' })],
      { sheets: sheet, attio: ownedByBhc1(), logger: silent, fixRunId: 'RECON-FIX-1' },
    );
    expect(r.groups[0]!.orphansCleared).toEqual(['BHC-3']); // 20 failed, 30 still repaired
    expect(sheet.cells.get('F30')).toContain('S4-ORPHAN');
  });

  it('an orphan whose Location needs no change still gets its note', async () => {
    // Location GOOGLE: no C write is attempted at all, so the new guard must not
    // accidentally skip the note for the rows that never needed a Location fix.
    const sheet = new FakeSheet([
      { row: 10, a: 'BHC-1', c: 'BOTH', e: 'rec-shared' },
      { row: 20, a: 'BHC-2', c: 'GOOGLE', e: 'rec-shared' },
    ]);
    const rows = [
      s4row({ masterRow: 10, bhcId: 'BHC-1', attioRecordId: 'rec-shared' }),
      s4row({ masterRow: 20, bhcId: 'BHC-2', fullName: 'Bob Other', location: 'GOOGLE', attioRecordId: 'rec-shared' }),
    ];
    const r = await repairS4(rows, { sheets: sheet, attio: ownedByBhc1(), logger: silent, fixRunId: 'RECON-FIX-1' });
    expect(r.groups[0]!.orphansCleared).toEqual(['BHC-2']);
    expect(sheet.updates.map((u) => u.range)).toEqual(['E20', 'F20']); // no C write
  });

  it('the note references the canonical BHC_ID and contains no row number', () => {
    const note = s4OrphanNote('rec-shared', 'BHC-1', 'RECON-FIX-1');
    expect(note).toContain('belongs to BHC-1');
    expect(note).not.toMatch(/\brow \d+/); // the spec template says "at row N"; 6b forbids it
  });
});
