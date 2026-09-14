/**
 * Master_ID column F: notes are APPENDED, and a repeated condition is recorded ONCE.
 *
 * ⚠ THE TWO HALVES ARE DIFFERENT GUARDS, AND EACH HAS ITS OWN TEST.
 *   - An append that OVERWRITES must fail: the cell is seeded with real-shaped
 *     history and the result must EQUAL "history | note".
 *   - A skip that does NOT skip must fail: the same condition is already present
 *     under a different run id, and ZERO updates may be issued.
 * A test asserting only "the note is there" passes both mutants — an overwrite
 * contains the note, and so does a duplicate append.
 */

import { describe, expect, it } from 'vitest';

import {
  appendMasterNote, composeNotes, noteSegments, sameCondition, writeMasterCell, type NoteKey,
} from '../../src/passes/reconciler-fix/master-write.js';
import type { Logger, MasterSheetPort } from '../../src/passes/reconciler-fix/ports.js';

const silent: Logger = { info: () => {}, warn: () => {} };

class Sheet implements MasterSheetPort {
  cells = new Map<string, string>();
  updates: { range: string; value: string }[] = [];
  /** Called right after an update lands — simulates another writer. */
  afterUpdate: ((cells: Map<string, string>) => void) | null = null;
  constructor(row: number, a: string, f = '') {
    this.cells.set(`A${row}`, a);
    this.cells.set(`F${row}`, f);
  }
  private key(range: string) { const m = /Master_ID!([A-F])(\d+)/.exec(range)!; return `${m[1]}${m[2]}`; }
  async read(range: string) { return [[this.cells.get(this.key(range)) ?? '']]; }
  async update(range: string, values: unknown[][]) {
    const k = this.key(range); const v = String(values[0]?.[0] ?? '');
    this.updates.push({ range: k, value: v }); this.cells.set(k, v);
    if (this.afterUpdate) { this.afterUpdate(this.cells); this.afterUpdate = null; }
    return {};
  }
}

// Real-shaped history, copied in form from live Master_ID notes.
const HISTORY = 'TNB staff.';
const REPOINT = (run: string) =>
  `A3-FIXED: Attio record_id updated from rec-old to rec-new by Reconciler Fix ${run}.`;
const REPOINT_KEY: NoteKey = { marker: 'A3-FIXED', expected: 'to rec-new' };

const append = (sheet: Sheet, note: string, key: NoteKey) =>
  appendMasterNote(sheet, silent, { masterRow: 10, note, key, expectedBhcId: 'BHC-1' });

describe('HALF ONE — an append must never overwrite', () => {
  it('⚠ joins onto existing history: the cell EQUALS "history | note", nothing lost', async () => {
    const sheet = new Sheet(10, 'BHC-1', HISTORY);
    const r = await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(r.outcome).toBe('written');
    expect(sheet.cells.get('F10')).toBe(`${HISTORY} | ${REPOINT('RECON-FIX-2')}`);
  });

  it('keeps a MULTI-segment history intact, in order', async () => {
    const hist = 'Merged. Primary: 4f95779c. | 2026-07-14 CORRECTION: name-mismatch bug in PASS 5';
    const sheet = new Sheet(10, 'BHC-1', hist);
    await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(sheet.cells.get('F10')).toBe(`${hist} | ${REPOINT('RECON-FIX-2')}`);
  });

  it('an empty cell gets the note alone, with no leading separator', async () => {
    const sheet = new Sheet(10, 'BHC-1', '');
    await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(sheet.cells.get('F10')).toBe(REPOINT('RECON-FIX-2'));
  });
});

describe('HALF TWO — a repeated condition must not be appended again', () => {
  it('⚠ the same condition under a DIFFERENT run id issues ZERO updates and leaves the cell identical', async () => {
    const existing = `${HISTORY} | ${REPOINT('RECON-FIX-1')}`;
    const sheet = new Sheet(10, 'BHC-1', existing);
    const r = await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(r.outcome).toBe('already_present');
    expect(sheet.updates).toHaveLength(0);
    expect(sheet.cells.get('F10')).toBe(existing);
  });

  it('recurring every run still records it exactly once', async () => {
    const sheet = new Sheet(10, 'BHC-1', HISTORY);
    for (const run of ['RECON-FIX-1', 'RECON-FIX-2', 'RECON-FIX-3']) await append(sheet, REPOINT(run), REPOINT_KEY);
    expect(noteSegments(sheet.cells.get('F10')!).filter((x) => x.startsWith('A3-FIXED'))).toHaveLength(1);
    expect(sheet.updates).toHaveLength(1);
  });

  it('⚠ a DIFFERENT expected value under the same marker is a new condition, and IS appended', async () => {
    const existing = `${HISTORY} | ${REPOINT('RECON-FIX-1')}`;
    const sheet = new Sheet(10, 'BHC-1', existing);
    const other = 'A3-FIXED: Attio record_id updated from rec-new to rec-newer by Reconciler Fix RECON-FIX-2.';
    const r = await append(sheet, other, { marker: 'A3-FIXED', expected: 'to rec-newer' });
    expect(r.outcome).toBe('written');
    expect(sheet.cells.get('F10')).toBe(`${existing} | ${other}`);
  });

  it('a different FIELD under the same marker and value is a new condition', async () => {
    const titleNote = 'I1-POINTER-MISMATCH: Attio bhc_contact_id is BHC-9, expected BHC-1. Title not synced - this is an A1 condition. Reconciler Fix RECON-FIX-1.';
    const emailNote = 'I1-POINTER-MISMATCH: Attio bhc_contact_id is BHC-9, expected BHC-1. Email not synced - this is an A1 condition. Reconciler Fix RECON-FIX-2.';
    const sheet = new Sheet(10, 'BHC-1', titleNote);
    const r = await append(sheet, emailNote, { marker: 'I1-POINTER-MISMATCH', field: 'Email', expected: 'expected BHC-1' });
    expect(r.outcome).toBe('written');
  });
});

describe('the read-back must EQUAL the composed cell, not merely contain the note', () => {
  it('⚠ a writer that REPLACES the history right after our update is caught', async () => {
    const sheet = new Sheet(10, 'BHC-1', HISTORY);
    // After our write, something overwrites F with just our note — it still CONTAINS the note.
    sheet.afterUpdate = (cells) => cells.set('F10', REPOINT('RECON-FIX-2'));
    const r = await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(r.outcome).toBe('readback_mismatch');
  });

  it('a hand edit landing between our write and the read-back is caught', async () => {
    const sheet = new Sheet(10, 'BHC-1', HISTORY);
    sheet.afterUpdate = (cells) => cells.set('F10', `${cells.get('F10')} | typed by hand`);
    const r = await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(r.outcome).toBe('readback_mismatch');
  });
});

describe('col A is still guarded on both sides', () => {
  it('refuses to write when col A already disagrees', async () => {
    const sheet = new Sheet(10, 'BHC-OTHER', HISTORY);
    const r = await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(r.outcome).toBe('col_a_changed');
    expect(sheet.updates).toHaveLength(0);
  });

  it('col A changing during the write is a hard stop', async () => {
    const sheet = new Sheet(10, 'BHC-1', HISTORY);
    sheet.afterUpdate = (cells) => cells.set('A10', 'BHC-CHANGED');
    const r = await append(sheet, REPOINT('RECON-FIX-2'), REPOINT_KEY);
    expect(r.outcome).toBe('col_a_changed');
  });
});

describe('sameCondition, pure', () => {
  it('ignores the run id', () => {
    expect(sameCondition(REPOINT('RECON-FIX-1'), REPOINT_KEY)).toBe(true);
    expect(sameCondition(REPOINT('RECON-FIX-999'), REPOINT_KEY)).toBe(true);
  });
  it('requires the marker as the segment PREFIX, not anywhere', () => {
    expect(sameCondition(`Note about A3-FIXED: to rec-new`, REPOINT_KEY)).toBe(false);
  });
  it('requires the expected value when given', () => {
    expect(sameCondition(REPOINT('RECON-FIX-1'), { marker: 'A3-FIXED', expected: 'to rec-other' })).toBe(false);
  });
  it('composeNotes joins with the separator and never adds one to an empty cell', () => {
    expect(composeNotes('', 'N')).toBe('N');
    expect(composeNotes('H', 'N')).toBe('H | N');
  });
});

describe('writeMasterCell can no longer target column F', () => {
  it('is refused by the type system', async () => {
    const sheet = new Sheet(10, 'BHC-1', HISTORY);
    // @ts-expect-error — 'F' is not a WritableColumn: notes go through appendMasterNote.
    const r = await writeMasterCell(sheet, silent, { masterRow: 10, column: 'F', value: 'x', expectedBhcId: 'BHC-1' });
    expect(r).toBeDefined();
  });
});
