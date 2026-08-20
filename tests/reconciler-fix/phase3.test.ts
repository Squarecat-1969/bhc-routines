import { describe, expect, it } from 'vitest';

import { repairA1, type A1Candidate } from '../../src/passes/reconciler-fix/a1.js';
import { repairI1, type I1Candidate, type I1Field } from '../../src/passes/reconciler-fix/i1.js';
import type {
  AttioIdentityWritePort, AttioPerson, AttioWritableFields, Logger, MasterSheetPort,
} from '../../src/passes/reconciler-fix/ports.js';

const silent: Logger = { info: () => {}, warn: () => {} };

class FakeSheet implements MasterSheetPort {
  cells = new Map<string, string>();
  updates: { range: string; value: string }[] = [];
  constructor(rows: { row: number; a: string }[]) {
    for (const r of rows) { this.cells.set(`A${r.row}`, r.a); this.cells.set(`F${r.row}`, ''); }
  }
  private key(range: string) { const m = /Master_ID!([A-F])(\d+)/.exec(range)!; return `${m[1]}${m[2]}`; }
  async read(range: string) { return [[this.cells.get(this.key(range)) ?? '']]; }
  async update(range: string, values: unknown[][]) {
    const k = this.key(range); const v = String(values[0]?.[0] ?? '');
    this.updates.push({ range: k, value: v }); this.cells.set(k, v); return {};
  }
}

/** Records the exact payload of every Attio write — that is what the tests assert on. */
class FakeAttio implements AttioIdentityWritePort {
  writes: { recordId: string; values: AttioWritableFields }[] = [];
  rejectWith: string | null = null;
  /** Applied to the stored record after a successful write, to simulate QA drift. */
  sabotageAfterWrite: ((p: AttioPerson) => AttioPerson) | null = null;

  constructor(
    public records: Record<string, AttioPerson>,
    private emailOwners: Record<string, readonly AttioPerson[]> = {},
  ) {}

  async getByRecordId(recordId: string) { return this.records[recordId] ?? null; }
  async queryByBhcContactId(bhcId: string) { return Object.values(this.records).filter((r) => r.bhcContactId === bhcId); }
  async queryByEmail(email: string) { return this.emailOwners[email.toLowerCase()] ?? []; }

  async updatePerson(recordId: string, values: AttioWritableFields) {
    if (this.rejectWith) throw new Error(this.rejectWith);
    this.writes.push({ recordId, values });
    const cur = this.records[recordId]!;
    // Spread-then-assign only the keys actually present: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent optional property.
    let next: AttioPerson = { ...cur };
    if (values.bhc_contact_id !== undefined) next = { ...next, bhcContactId: values.bhc_contact_id };
    if (values.job_title !== undefined) next = { ...next, jobTitle: values.job_title };
    if (values.company_name !== undefined) next = { ...next, companyName: values.company_name };
    if (values.email_addresses !== undefined) next = { ...next, emails: values.email_addresses };
    if (this.sabotageAfterWrite) { next = this.sabotageAfterWrite(next); this.sabotageAfterWrite = null; }
    this.records[recordId] = next;
  }
}

const person = (o: Partial<AttioPerson> = {}): AttioPerson => ({
  recordId: 'rec-1', bhcContactId: 'BHC-1', name: 'Ada Lovelace',
  jobTitle: 'Engineer', companyName: 'Analytical Co', emails: ['ada@x.com'], ...o,
});
const a1c = (o: Partial<A1Candidate> = {}): A1Candidate =>
  ({ masterRow: 10, bhcId: 'BHC-1', fullName: 'Ada Lovelace', attioRecordId: 'rec-1', expectedBhcId: 'BHC-1', ...o });
const i1c = (field: I1Field, o: Partial<I1Candidate> = {}): I1Candidate =>
  ({ masterRow: 10, bhcId: 'BHC-1', fullName: 'Ada Lovelace', attioRecordId: 'rec-1', field, expected: 'X', ...o });

const deps = (sheet: FakeSheet, attio: FakeAttio) =>
  ({ sheets: sheet, attio, logger: silent, fixRunId: 'RECON-FIX-1' });

// ════════════════════════════════════════════════════════════════════════════
// BUG-SHAPED FIRST — designed to catch a specific mistake.
// ════════════════════════════════════════════════════════════════════════════
describe('BUG-SHAPED: the I1 gate must NOT collapse into just the name check', () => {
  it('name PASSES but bhc_contact_id is wrong -> NEEDS_MANUAL, zero Attio writes', async () => {
    // The record is plausibly the right human by name, but the identity pointer
    // says otherwise. That is an A1 defect; I1 writing anyway would push
    // Google's values onto a record that may belong to someone else.
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ bhcContactId: 'BHC-999', name: 'Ada Lovelace' }) });
    const r = await repairI1([i1c('Title', { expected: 'Director' })], deps(sheet, attio));

    expect(r.rows[0]!.outcome).toBe('pointer_mismatch');
    expect(attio.writes).toHaveLength(0);
    expect(sheet.cells.get('F10')).toContain('I1-POINTER-MISMATCH');
    expect(sheet.cells.get('F10')).toContain('this is an A1 condition');
  });

  it('pointer_mismatch is DISTINCT from a pure name failure', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ bhcContactId: 'BHC-1', name: 'Someone Entirely Else' }) });
    const r = await repairI1([i1c('Title', { expected: 'Director' })], deps(sheet, attio));

    expect(r.rows[0]!.outcome).toBe('name_mismatch'); // not pointer_mismatch
    expect(attio.writes).toHaveLength(0);
    expect(sheet.cells.get('F10')).toContain('I1-NAME-MISMATCH');
  });

  it('A1 by contrast requires ONLY the name gate — a differing bhc_contact_id is the thing it fixes', async () => {
    // Proves the two gates really are different: the same record state that
    // blocks I1 is exactly what A1 exists to repair.
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ bhcContactId: 'BHC-999' }) });
    const r = await repairA1([a1c()], deps(sheet, attio));

    expect(r.rows[0]!.outcome).toBe('fixed');
    expect(attio.writes).toEqual([{ recordId: 'rec-1', values: { bhc_contact_id: 'BHC-1' } }]);
  });
});

describe('BUG-SHAPED: an email uniqueness conflict must never be missed', () => {
  it('the address already belongs to a DIFFERENT record -> NEEDS_MANUAL, no write', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio(
      { 'rec-1': person() },
      { 'new@x.com': [person({ recordId: 'rec-SOMEONE-ELSE' })] },
    );
    const r = await repairI1([i1c('Email', { expected: 'new@x.com' })], deps(sheet, attio));

    expect(r.rows[0]!.outcome).toBe('email_unique_conflict');
    expect(attio.writes).toHaveLength(0); // never even attempted
    expect(sheet.cells.get('F10')).toContain('I1-EMAIL-UNIQUE-CONFLICT');
  });

  it('the address already on THIS record is not a conflict', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio(
      { 'rec-1': person({ emails: ['old@x.com', 'new@x.com'] }) },
      { 'new@x.com': [person({ recordId: 'rec-1' })] },
    );
    const r = await repairI1([i1c('Email', { expected: 'new@x.com' })], deps(sheet, attio));
    expect(r.rows[0]!.outcome).toBe('fixed');
    expect(attio.writes[0]!.values.email_addresses).toEqual(['new@x.com', 'old@x.com']);
  });

  it('a FAILED uniqueness query refuses to write — never assumes the address is free', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person() });
    attio.queryByEmail = async () => { throw new Error('attio 500'); };
    const r = await repairI1([i1c('Email', { expected: 'new@x.com' })], deps(sheet, attio));

    expect(r.rows[0]!.outcome).toBe('email_unique_conflict');
    expect(attio.writes).toHaveLength(0);
  });

  it('a uniqueness REJECTION at write time is still caught, not treated as a generic failure', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person() });
    attio.rejectWith = 'uniqueness constraint violated on email_addresses';
    const r = await repairI1([i1c('Email', { expected: 'new@x.com' })], deps(sheet, attio));
    expect(r.rows[0]!.outcome).toBe('email_unique_conflict');
  });
});

describe('BUG-SHAPED: the gate must run BEFORE any write, never after', () => {
  it('A1 name mismatch writes a note and zero Attio calls', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ name: 'Completely Different Human' }) });
    const r = await repairA1([a1c()], deps(sheet, attio));

    expect(r.rows[0]!.outcome).toBe('name_mismatch');
    expect(attio.writes).toHaveLength(0);
    expect(sheet.cells.get('F10')).toContain('A1-NAME-MISMATCH');
    expect(sheet.cells.get('F10')).toContain('Pointer may reference wrong person');
  });

  it('an UNVERIFIABLE name is distinct from a mismatch, and also writes nothing', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ name: '' }) });
    const r = await repairA1([a1c()], deps(sheet, attio));
    expect(r.rows[0]!.outcome).toBe('name_unavailable');
    expect(attio.writes).toHaveLength(0);
    expect(sheet.cells.get('F10')).toContain('name unavailable for verification');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A1 happy path + QA
// ════════════════════════════════════════════════════════════════════════════
describe('A1', () => {
  it('writes bhc_contact_id and verifies it landed', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ bhcContactId: 'BHC-WRONG' }) });
    const r = await repairA1([a1c()], deps(sheet, attio));
    expect(r.counts).toMatchObject({ considered: 1, fixed: 1, attioWrites: 1 });
    expect(attio.records['rec-1']!.bhcContactId).toBe('BHC-1');
  });

  it('a record that has vanished is an A3 condition, not an A1 write', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const r = await repairA1([a1c()], deps(sheet, new FakeAttio({})));
    expect(r.rows[0]!.outcome).toBe('record_not_found');
  });

  it('QA failure after a successful write is qa_failed, not fixed', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ bhcContactId: 'BHC-WRONG' }) });
    attio.sabotageAfterWrite = (p) => ({ ...p, bhcContactId: 'STILL-WRONG' });
    const r = await repairA1([a1c()], deps(sheet, attio));
    expect(r.rows[0]!.outcome).toBe('qa_failed');
    expect(r.rows[0]!.attioWritten).toBe(true); // honest: the write did happen
  });
});

// ════════════════════════════════════════════════════════════════════════════
// I1 field syncs
// ════════════════════════════════════════════════════════════════════════════
describe('I1 field syncs', () => {
  it('Title writes job_title', async () => {
    const attio = new FakeAttio({ 'rec-1': person({ jobTitle: 'Old' }) });
    const r = await repairI1([i1c('Title', { expected: 'Head of Content' })], deps(new FakeSheet([{ row: 10, a: 'BHC-1' }]), attio));
    expect(r.rows[0]!.outcome).toBe('fixed');
    expect(attio.writes[0]!.values).toEqual({ job_title: 'Head of Content' });
  });

  it('Company writes company_name — the TEXT attr, never a record-reference', async () => {
    const attio = new FakeAttio({ 'rec-1': person({ companyName: 'Old Co' }) });
    const r = await repairI1([i1c('Company', { expected: 'MediaCo' })], deps(new FakeSheet([{ row: 10, a: 'BHC-1' }]), attio));
    expect(r.rows[0]!.outcome).toBe('fixed');
    expect(attio.writes[0]!.values).toEqual({ company_name: 'MediaCo' });
    expect(Object.keys(attio.writes[0]!.values)).not.toContain('company');
  });

  it('Email sends buildEmailList output: new primary first, secondaries preserved', async () => {
    const attio = new FakeAttio({ 'rec-1': person({ emails: ['old@x.com', 'keep@x.com'] }) });
    const r = await repairI1([i1c('Email', { expected: 'new@x.com' })], deps(new FakeSheet([{ row: 10, a: 'BHC-1' }]), attio));
    expect(r.rows[0]!.outcome).toBe('fixed');
    expect(attio.writes[0]!.values.email_addresses).toEqual(['new@x.com', 'old@x.com', 'keep@x.com']);
  });

  it('skips a field that already matches — no pointless write', async () => {
    const attio = new FakeAttio({ 'rec-1': person({ jobTitle: 'Engineer' }) });
    const r = await repairI1([i1c('Title', { expected: 'engineer' })], deps(new FakeSheet([{ row: 10, a: 'BHC-1' }]), attio));
    expect(r.rows[0]!.outcome).toBe('already_correct');
    expect(attio.writes).toHaveLength(0);
  });

  it('NEVER includes a name key in any write payload', async () => {
    const attio = new FakeAttio({ 'rec-1': person({ jobTitle: 'Old', companyName: 'Old', emails: ['a@x.com'] }) });
    await repairI1(
      [i1c('Title', { expected: 'T' }), i1c('Company', { expected: 'C' }), i1c('Email', { expected: 'e@x.com' })],
      deps(new FakeSheet([{ row: 10, a: 'BHC-1' }]), attio),
    );
    for (const w of attio.writes) expect(Object.keys(w.values)).not.toContain('name');
  });
});

describe('I1 per-field isolation (non-negotiable 5 at field granularity)', () => {
  it('a Title failure does NOT stop Company or Email on the same contact', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ jobTitle: 'Old', companyName: 'Old Co', emails: ['old@x.com'] }) });
    // Title's write lands but QA sabotage makes it fail verification.
    attio.sabotageAfterWrite = (p) => ({ ...p, jobTitle: 'NOT WHAT WE WROTE' });

    const r = await repairI1([
      i1c('Title', { expected: 'New Title' }),
      i1c('Company', { expected: 'New Co' }),
      i1c('Email', { expected: 'new@x.com' }),
    ], deps(sheet, attio));

    expect(r.rows.map((x) => x.outcome)).toEqual(['qa_failed', 'fixed', 'fixed']);
    expect(attio.records['rec-1']!.companyName).toBe('New Co');
    expect(attio.records['rec-1']!.emails?.[0]).toBe('new@x.com');
  });

  it('an unexpected throw on one field is contained to that field', async () => {
    const sheet = new FakeSheet([{ row: 10, a: 'BHC-1' }]);
    const attio = new FakeAttio({ 'rec-1': person({ companyName: 'Old Co' }) });
    let first = true;
    const realGet = attio.getByRecordId.bind(attio);
    attio.getByRecordId = async (id: string) => { if (first) { first = false; throw new Error('boom'); } return realGet(id); };

    const r = await repairI1([i1c('Title', { expected: 'T' }), i1c('Company', { expected: 'New Co' })], deps(sheet, attio));
    expect(r.rows[0]!.outcome).toBe('lookup_failed');
    expect(r.rows[1]!.outcome).toBe('fixed');
  });
});
