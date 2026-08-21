import { describe, expect, it } from 'vitest';
import { runReconcilerFix } from '../../src/passes/reconciler-fix/index.js';
import type { Logger } from '../../src/passes/reconciler-fix/ports.js';

/**
 * The A1/S4 interaction bug, reproduced at the exact shape that corrupted test
 * data on the first live run.
 *
 * The two rows are the SAME human ("Ada Lovelace" / "Ada L") - which is WHY
 * they share a pointer at all - so the name gate cannot tell them apart and
 * offers no protection here. With different names the gate blocks A1 and the
 * bug is unreachable; with matching names, which is the normal S4 shape, it is
 * fully reachable.
 *
 * TWO Master_ID rows share one Attio pointer (rec-shared). Attio itself says
 * the record belongs to BHC-1. BHC-2 is ALSO independently flagged A1, because
 * Master_ID row 3 claims BHC-2 while Attio says BHC-1 - which is not an
 * independent defect at all, it is precisely the ownership question S4 exists
 * to adjudicate.
 *
 * Pre-fix: A1 runs first, overwrites rec-shared's bhc_contact_id to BHC-2, and
 * S4's (correct) ownership check then reads back the value A1 just corrupted -
 * concluding BHC-2 is canonical and clearing the TRUE owner BHC-1's pointer.
 */
const silent: Logger = { info: () => {}, warn: () => {} };
const logged = () => { const lines: string[] = []; return { lines, logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } as Logger }; };

const REPORT = [
  // A1 for BHC-2: Master_ID claims BHC-2, Attio has BHC-1.
  ['RECON-9', '', 'BHC-2', 'Ada L', '3', '', 'rec-shared', 'BOTH', 'A1', '', '', 'BHC-2', 'BHC-1', ''],
  // S4 for the same pointer.
  ['RECON-9', '', 'BHC-1', 'Ada Lovelace', '2', '', 'rec-shared', 'BOTH', 'S4', '', '', '', '', ''],
];
const MASTER = [
  ['BHC-1', 'Ada Lovelace', 'BOTH', '100', 'rec-shared', ''], // row 2 - TRUE owner
  ['BHC-2', 'Ada L', 'BOTH', '101', 'rec-shared', ''],        // row 3 - wrong claimant, SAME human
];

function world() {
  const master = MASTER.map((r) => [...r]);
  const attio = { 'rec-shared': { bhcContactId: 'BHC-1', name: 'Ada Lovelace' } };
  const sheets = {
    async read(range: string) {
      if (range.startsWith('Reconciler_Report')) return REPORT;
      if (range.startsWith('Master_ID!A2')) return master;
      const m = /Master_ID!([A-F])(\d+)/.exec(range);
      if (m) {
        const col = 'ABCDEF'.indexOf(m[1]!); const row = Number(m[2]) - 2;
        return [[master[row]?.[col] ?? '']];
      }
      return [];
    },
    async update(range: string, values: unknown[][]) {
      const m = /Master_ID!([A-F])(\d+)/.exec(range)!;
      const col = 'ABCDEF'.indexOf(m[1]!); const row = Number(m[2]) - 2;
      if (master[row]) master[row]![col] = String(values[0]?.[0] ?? '');
      return {};
    },
  };
  const attioClient = {
    async getPersonRecord(recordId: string) {
      const rec = attio[recordId as keyof typeof attio];
      if (!rec) throw new Error('404 not found');
      return { recordId, values: { bhc_contact_id: [{ value: rec.bhcContactId }], name: [{ full_name: rec.name }] } };
    },
    async queryPeople() { return []; },
    async updatePersonRecord(recordId: string, values: Record<string, unknown>) {
      const rec = attio[recordId as keyof typeof attio];
      if (rec && typeof values['bhc_contact_id'] === 'string') rec.bhcContactId = values['bhc_contact_id'] as string;
    },
  };
  return { master, attio, sheets, attioClient };
}

describe('A1/S4 interaction — the disputed-pointer bug', () => {
  it('REPRODUCES the corruption when A1 is not excluded (documents the pre-fix behaviour)', async () => {
    const w = world();
    // Simulate PRE-fix by feeding A1 the disputed row directly, which is exactly
    // what the unfiltered candidate build did.
    const { repairA1 } = await import('../../src/passes/reconciler-fix/a1.js');
    const { repairS4 } = await import('../../src/passes/reconciler-fix/s4.js');
    const { makeAttioIdentityWritePort, makeMasterSheetPort } = await import('../../src/passes/reconciler-fix/adapters.js');
    const ports = { sheets: makeMasterSheetPort(w.sheets as never), attio: makeAttioIdentityWritePort(w.attioClient as never) };

    await repairA1([{ masterRow: 3, bhcId: 'BHC-2', fullName: 'Ada L', attioRecordId: 'rec-shared', expectedBhcId: 'BHC-2' }],
      { sheets: ports.sheets, attio: ports.attio, logger: silent, fixRunId: 'FIX-1' });
    // A1 has now corrupted the shared record.
    expect(w.attio['rec-shared'].bhcContactId).toBe('BHC-2');

    await repairS4(
      [
        { masterRow: 2, bhcId: 'BHC-1', fullName: 'Ada Lovelace', location: 'BOTH', googleRow: 100, attioRecordId: 'rec-shared' },
        { masterRow: 3, bhcId: 'BHC-2', fullName: 'Ada L', location: 'BOTH', googleRow: 101, attioRecordId: 'rec-shared' },
      ],
      { sheets: ports.sheets, attio: ports.attio, logger: silent, fixRunId: 'FIX-1' },
    );

    // THE CORRUPTION: the true owner lost its pointer, the wrong claimant kept one.
    expect(w.master[0]![4]).toBe('');            // BHC-1 (true owner) CLEARED
    expect(w.master[1]![4]).toBe('rec-shared');  // BHC-2 (wrong claimant) KEPT
  });

  it('THE FIX: A1 excludes the disputed row, S4 resolves from uncorrupted state', async () => {
    const w = world();
    const { lines, logger } = logged();
    const r = await runReconcilerFix({
      sheets: w.sheets as never, attio: w.attioClient as never, logger,
      dryRun: false, fixRunId: 'FIX-1',
    });

    // A1 skipped it — visibly, not silently.
    expect(r.a1.counts.considered).toBe(0);
    expect(r.excludedFromA1).toEqual(['BHC-2']);
    expect(lines.some((l) => l.includes('excluded from A1') && l.includes('rec-shared'))).toBe(true);

    // Attio was never written by A1 — the record still says what it always said.
    expect(w.attio['rec-shared'].bhcContactId).toBe('BHC-1');

    // S4 resolved correctly: true owner keeps the pointer, wrong claimant cleared.
    expect(w.master[0]![4]).toBe('rec-shared'); // BHC-1 KEEPS it
    expect(w.master[1]![4]).toBe('');           // BHC-2 CLEARED
    expect(r.s4.groups[0]!.canonicalBhcId).toBe('BHC-1');
  });

  it('does NOT over-correct: a standalone A1 with no S4 overlap is still fixed', async () => {
    const master = [['BHC-9', 'Solo Person', 'BOTH', '200', 'rec-solo', '']];
    const attio = { 'rec-solo': { bhcContactId: 'BHC-WRONG', name: 'Solo Person' } };
    const report = [['RECON-9', '', 'BHC-9', 'Solo Person', '2', '', 'rec-solo', 'BOTH', 'A1', '', '', 'BHC-9', 'BHC-WRONG', '']];
    const sheets = {
      async read(range: string) {
        if (range.startsWith('Reconciler_Report')) return report;
        if (range.startsWith('Master_ID!A2')) return master;
        const m = /Master_ID!([A-F])(\d+)/.exec(range);
        if (m) return [[master[Number(m[2]) - 2]?.['ABCDEF'.indexOf(m[1]!)] ?? '']];
        return [];
      },
      async update() { return {}; },
    };
    const attioClient = {
      async getPersonRecord(id: string) {
        const rec = attio[id as keyof typeof attio];
        return { recordId: id, values: { bhc_contact_id: [{ value: rec.bhcContactId }], name: [{ full_name: rec.name }] } };
      },
      async queryPeople() { return []; },
      async updatePersonRecord(id: string, v: Record<string, unknown>) {
        const rec = attio[id as keyof typeof attio];
        if (typeof v['bhc_contact_id'] === 'string') rec.bhcContactId = v['bhc_contact_id'] as string;
      },
    };
    const r = await runReconcilerFix({ sheets: sheets as never, attio: attioClient as never, logger: silent, dryRun: false, fixRunId: 'FIX-1' });

    expect(r.excludedFromA1).toEqual([]);
    expect(r.a1.counts.fixed).toBe(1);
    expect(attio['rec-solo'].bhcContactId).toBe('BHC-9');
  });
});

/**
 * I1 checked for the same class of risk (acceptance 5).
 *
 * I1 is structurally protected where A1 was not, and the reason is specific:
 * A1's gate is name-only, and on a contested pointer the two claimants are
 * usually the same human, so names match and the gate passes. I1's gate
 * additionally requires bhc_contact_id == BHC_ID, and a shared Attio record
 * carries exactly ONE bhc_contact_id - so the wrong claimant fails by
 * construction, no exclusion list required.
 */
describe('I1 on a contested pointer — protected by its own second gate', () => {
  const contested = (bhcContactId: string) => {
    const attio = { 'rec-shared': { bhcContactId, name: 'Ada Lovelace', jobTitle: 'Old' } };
    return {
      attio,
      client: {
        async getPersonRecord(id: string) {
          const r = attio[id as keyof typeof attio];
          return { recordId: id, values: { bhc_contact_id: [{ value: r.bhcContactId }], name: [{ full_name: r.name }], job_title: [{ value: r.jobTitle }] } };
        },
        async queryPeople() { return []; },
        async updatePersonRecord(id: string, v: Record<string, unknown>) {
          const r = attio[id as keyof typeof attio];
          if (typeof v['job_title'] === 'string') r.jobTitle = v['job_title'] as string;
        },
      },
    };
  };
  const sheets = { async read() { return [['BHC-2']]; }, async update() { return {}; } };

  it('the WRONG claimant is blocked — pointer_mismatch, zero Attio write', async () => {
    const { repairI1 } = await import('../../src/passes/reconciler-fix/i1.js');
    const { makeAttioIdentityWritePort, makeMasterSheetPort } = await import('../../src/passes/reconciler-fix/adapters.js');
    const w = contested('BHC-1'); // Attio says the record belongs to BHC-1
    const r = await repairI1(
      [{ masterRow: 3, bhcId: 'BHC-2', fullName: 'Ada L', attioRecordId: 'rec-shared', field: 'Title', expected: 'New Title' }],
      { sheets: makeMasterSheetPort(sheets as never), attio: makeAttioIdentityWritePort(w.client as never), logger: silent, fixRunId: 'FIX-1' },
    );
    expect(r.rows[0]!.outcome).toBe('pointer_mismatch');
    expect(w.attio['rec-shared'].jobTitle).toBe('Old'); // untouched
  });

  it('the TRUE owner still syncs normally — the guard is not over-broad', async () => {
    const { repairI1 } = await import('../../src/passes/reconciler-fix/i1.js');
    const { makeAttioIdentityWritePort, makeMasterSheetPort } = await import('../../src/passes/reconciler-fix/adapters.js');
    const w = contested('BHC-1');
    const r = await repairI1(
      [{ masterRow: 2, bhcId: 'BHC-1', fullName: 'Ada Lovelace', attioRecordId: 'rec-shared', field: 'Title', expected: 'New Title' }],
      { sheets: makeMasterSheetPort({ async read() { return [['BHC-1']]; }, async update() { return {}; } } as never), attio: makeAttioIdentityWritePort(w.client as never), logger: silent, fixRunId: 'FIX-1' },
    );
    expect(r.rows[0]!.outcome).toBe('fixed');
    expect(w.attio['rec-shared'].jobTitle).toBe('New Title');
  });
});
