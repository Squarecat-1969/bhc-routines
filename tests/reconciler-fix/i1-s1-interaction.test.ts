import { describe, expect, it } from 'vitest';
import { runReconcilerFix } from '../../src/passes/reconciler-fix/index.js';
import type { Logger } from '../../src/passes/reconciler-fix/ports.js';

/**
 * The I1/S1 gap — the residual the A1/S4 fix (PR #19) found and deliberately
 * left for its own follow-up.
 *
 * TWO Master_ID rows both claim BHC-1 (a real S1 duplicate), each pointing at
 * its OWN distinct Attio record. Each record genuinely carries BHC-1 and a
 * matching name, so each row's two-part I1 gate passes correctly FROM THAT
 * ROW'S OWN PERSPECTIVE. Neither row can see that a human has not yet decided
 * which of the two is the real person.
 *
 * Unlike the A1/S4 bug there is no cross-contamination — each write stays on
 * its own record — but both are writes onto a formally disputed identity.
 */
const silent: Logger = { info: () => {}, warn: () => {} };
const logged = () => {
  const lines: string[] = [];
  return { lines, logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } as Logger };
};

/** Two rows, same BHC_ID, different Attio records; both S1-flagged and I1-flagged. */
function disputedWorld() {
  const master = [
    ['BHC-1', 'Ada Lovelace', 'BOTH', '100', 'rec-A', ''], // row 2
    ['BHC-1', 'Ada Lovelace', 'BOTH', '101', 'rec-B', ''], // row 3 — same ID, own record
  ];
  const attio: Record<string, { bhcContactId: string; name: string; jobTitle: string }> = {
    'rec-A': { bhcContactId: 'BHC-1', name: 'Ada Lovelace', jobTitle: 'Old A' },
    'rec-B': { bhcContactId: 'BHC-1', name: 'Ada Lovelace', jobTitle: 'Old B' },
  };
  const report = [
    ['RECON-9', '', 'BHC-1', 'Ada Lovelace', '2', '', 'rec-A', 'BOTH', 'S1', '', '', '', '', ''],
    ['RECON-9', '', 'BHC-1', 'Ada Lovelace', '2', '', 'rec-A', 'BOTH', 'I1', '', '', 'New Title', '', 'Title'],
    ['RECON-9', '', 'BHC-1', 'Ada Lovelace', '3', '', 'rec-B', 'BOTH', 'I1', '', '', 'New Title', '', 'Title'],
  ];
  const sheets = {
    async read(range: string) {
      if (range.startsWith('Reconciler_Report')) return report;
      if (range.startsWith('Master_ID!A2')) return master;
      const m = /Master_ID!([A-F])(\d+)/.exec(range);
      if (m) return [[master[Number(m[2]) - 2]?.['ABCDEF'.indexOf(m[1]!)] ?? '']];
      return [];
    },
    async update(range: string, values: unknown[][]) {
      const m = /Master_ID!([A-F])(\d+)/.exec(range)!;
      const row = Number(m[2]) - 2;
      if (master[row]) master[row]!['ABCDEF'.indexOf(m[1]!)] = String(values[0]?.[0] ?? '');
      return {};
    },
  };
  const client = {
    async getPersonRecord(id: string) {
      const r = attio[id];
      if (!r) throw new Error('404 not found');
      return { recordId: id, values: { bhc_contact_id: [{ value: r.bhcContactId }], name: [{ full_name: r.name }], job_title: [{ value: r.jobTitle }] } };
    },
    async queryPeople() { return []; },
    async updatePersonRecord(id: string, v: Record<string, unknown>) {
      if (typeof v['job_title'] === 'string') attio[id]!.jobTitle = v['job_title'] as string;
    },
  };
  return { master, attio, sheets, client };
}

describe('I1 on an S1-disputed BHC_ID', () => {
  it('REPRODUCES the gap: each row\'s own gate passes, so BOTH records get written', async () => {
    const w = disputedWorld();
    const { repairI1 } = await import('../../src/passes/reconciler-fix/i1.js');
    const { makeAttioIdentityWritePort, makeMasterSheetPort } = await import('../../src/passes/reconciler-fix/adapters.js');
    const ports = { sheets: makeMasterSheetPort(w.sheets as never), attio: makeAttioIdentityWritePort(w.client as never) };

    // Fed directly, exactly as the unfiltered candidate build did.
    const r = await repairI1([
      { masterRow: 2, bhcId: 'BHC-1', fullName: 'Ada Lovelace', attioRecordId: 'rec-A', field: 'Title', expected: 'New Title' },
      { masterRow: 3, bhcId: 'BHC-1', fullName: 'Ada Lovelace', attioRecordId: 'rec-B', field: 'Title', expected: 'New Title' },
    ], { sheets: ports.sheets, attio: ports.attio, logger: silent, fixRunId: 'FIX-1' });

    // Both gates passed — correctly, from each row's own point of view.
    expect(r.rows.map((x) => x.outcome)).toEqual(['fixed', 'fixed']);
    // THE GAP: both Attio records written while the identity is unresolved.
    expect(w.attio['rec-A']!.jobTitle).toBe('New Title');
    expect(w.attio['rec-B']!.jobTitle).toBe('New Title');
  });

  it('THE FIX: both are excluded and logged, zero Attio writes, until a human resolves S1', async () => {
    const w = disputedWorld();
    const { lines, logger } = logged();
    const r = await runReconcilerFix({
      sheets: w.sheets as never, attio: w.client as never, logger, dryRun: false, fixRunId: 'FIX-1',
    });

    expect(r.i1.counts.considered).toBe(0);
    expect(r.i1.counts.attioWrites).toBe(0);
    expect(r.excludedFromI1).toEqual(['BHC-1', 'BHC-1']); // one per I1 finding
    expect(lines.some((l) => l.includes('excluded from I1') && l.includes('S1-disputed'))).toBe(true);

    // Neither record touched — both still hold their original titles.
    expect(w.attio['rec-A']!.jobTitle).toBe('Old A');
    expect(w.attio['rec-B']!.jobTitle).toBe('Old B');
  });

  it('S1 itself still runs — the duplicate is flagged for the human who must resolve it', async () => {
    const w = disputedWorld();
    const r = await runReconcilerFix({
      sheets: w.sheets as never, attio: w.client as never, logger: silent, dryRun: false, fixRunId: 'FIX-1',
    });
    expect(r.s1.counts.orphansFlagged).toBe(1); // the lower-scoring row gets its Notes flag
    expect(w.master[1]![5]).toContain('S1-DUPLICATE');
  });

  it('does NOT over-correct: a standalone I1 with no S1 overlap is still fixed', async () => {
    const master = [['BHC-9', 'Solo Person', 'BOTH', '200', 'rec-solo', '']];
    const attio: Record<string, { bhcContactId: string; name: string; jobTitle: string }> = {
      'rec-solo': { bhcContactId: 'BHC-9', name: 'Solo Person', jobTitle: 'Old' },
    };
    const report = [['RECON-9', '', 'BHC-9', 'Solo Person', '2', '', 'rec-solo', 'BOTH', 'I1', '', '', 'New Title', '', 'Title']];
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
    const client = {
      async getPersonRecord(id: string) {
        const r = attio[id]!;
        return { recordId: id, values: { bhc_contact_id: [{ value: r.bhcContactId }], name: [{ full_name: r.name }], job_title: [{ value: r.jobTitle }] } };
      },
      async queryPeople() { return []; },
      async updatePersonRecord(id: string, v: Record<string, unknown>) {
        if (typeof v['job_title'] === 'string') attio[id]!.jobTitle = v['job_title'] as string;
      },
    };
    const r = await runReconcilerFix({ sheets: sheets as never, attio: client as never, logger: silent, dryRun: false, fixRunId: 'FIX-1' });

    expect(r.excludedFromI1).toEqual([]);
    expect(r.i1.counts.fixed).toBe(1);
    expect(attio['rec-solo']!.jobTitle).toBe('New Title');
  });

  it('an I1 row is only excluded when its OWN BHC_ID is disputed, not any S1 in the run', async () => {
    // A different contact being S1-disputed must not block an unrelated I1 sync.
    const master = [
      ['BHC-DUP', 'Dup Person', 'BOTH', '10', 'rec-d1', ''],
      ['BHC-DUP', 'Dup Person', 'BOTH', '11', 'rec-d2', ''],
      ['BHC-OK', 'Fine Person', 'BOTH', '12', 'rec-ok', ''],
    ];
    const attio: Record<string, { bhcContactId: string; name: string; jobTitle: string }> = {
      'rec-ok': { bhcContactId: 'BHC-OK', name: 'Fine Person', jobTitle: 'Old' },
    };
    const report = [
      ['RECON-9', '', 'BHC-DUP', 'Dup Person', '2', '', 'rec-d1', 'BOTH', 'S1', '', '', '', '', ''],
      ['RECON-9', '', 'BHC-OK', 'Fine Person', '4', '', 'rec-ok', 'BOTH', 'I1', '', '', 'New Title', '', 'Title'],
    ];
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
    const client = {
      async getPersonRecord(id: string) {
        const r = attio[id];
        if (!r) throw new Error('404 not found');
        return { recordId: id, values: { bhc_contact_id: [{ value: r.bhcContactId }], name: [{ full_name: r.name }], job_title: [{ value: r.jobTitle }] } };
      },
      async queryPeople() { return []; },
      async updatePersonRecord(id: string, v: Record<string, unknown>) {
        if (typeof v['job_title'] === 'string') attio[id]!.jobTitle = v['job_title'] as string;
      },
    };
    const r = await runReconcilerFix({ sheets: sheets as never, attio: client as never, logger: silent, dryRun: false, fixRunId: 'FIX-1' });

    expect(r.excludedFromI1).toEqual([]);
    expect(r.i1.counts.fixed).toBe(1);
    expect(attio['rec-ok']!.jobTitle).toBe('New Title');
  });
});
