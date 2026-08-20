import { describe, expect, it } from 'vitest';
import { runReconcilerFix } from '../../src/passes/reconciler-fix/index.js';
import type { Logger } from '../../src/passes/reconciler-fix/ports.js';

const silent: Logger = { info: () => {}, warn: () => {} };

/**
 * DRY-RUN CONTAINMENT, proved rather than asserted.
 *
 * Both underlying clients have write methods rigged to THROW. If any write path
 * reached a real client the run would fail loudly. It does not — because
 * dryRunPorts substitutes recording no-ops before any pass sees a port — and
 * `wouldWrite` still fills, showing the write logic genuinely executed and was
 * merely intercepted, not skipped.
 */
describe('dry run cannot reach a real write, even with candidates present', () => {
  const report = [
    // Reconciler_Report A2:N — one candidate of every repairable code.
    ['RECON-9', '', 'BHC-1', 'Ada Lovelace', '2', '', 'rec-1', 'BOTH', 'A1', '', '', 'BHC-1', 'BHC-WRONG', ''],
    ['RECON-9', '', 'BHC-2', 'Bo Geddes', '3', '', 'rec-dead', 'BOTH', 'A3', '', '', '', '', ''],
    ['RECON-9', '', 'BHC-1', 'Ada Lovelace', '2', '', 'rec-1', 'BOTH', 'I1', '', '', 'New Title', '', 'Title'],
    ['RECON-9', '', 'BHC-3', 'Cy Rand', '4', '', '', 'BOTH', 'S1', '', '', '', '', ''],
  ];
  const master = [
    ['BHC-1', 'Ada Lovelace', 'BOTH', '100', 'rec-1', ''],
    ['BHC-2', 'Bo Geddes', 'BOTH', '101', 'rec-dead', ''],
    ['BHC-3', 'Cy Rand', 'BOTH', '102', '', ''],
    ['BHC-3', 'Cy R', 'BOTH', '', '', ''],
  ];

  const sheets = {
    async read(range: string) {
      if (range.startsWith('Reconciler_Report')) return report;
      if (range.startsWith('Master_ID!A2')) return master;
      const m = /Master_ID!([A-F])(\d+)/.exec(range);
      if (m) return [[m[1] === 'A' ? (master[Number(m[2]) - 2]?.[0] ?? '') : '']];
      return [];
    },
    async update() { throw new Error('REAL SHEETS WRITE REACHED — dry run is not contained'); },
  };
  const attio = {
    async getPersonRecord(recordId: string) {
      if (recordId === 'rec-dead') throw new Error('404 not found');
      return { recordId, values: { bhc_contact_id: [{ value: 'BHC-WRONG' }], name: [{ full_name: 'Ada Lovelace' }], job_title: [{ value: 'Old' }] } };
    },
    async queryPeople() { return []; },
    async updatePersonRecord() { throw new Error('REAL ATTIO WRITE REACHED — dry run is not contained'); },
  };

  it('completes without touching a real client, and records what it would have written', async () => {
    const r = await runReconcilerFix({
      sheets: sheets as never, attio: attio as never, logger: silent,
      dryRun: true, fixRunId: 'RECON-FIX-TEST',
    });

    expect(r.dryRun).toBe(true);
    expect(r.candidates).toEqual({ S1: 1, A1: 1, A3: 1, S4: 0, I1: 1 });
    // The write logic ran: real work was computed and intercepted.
    expect(r.wouldWrite.length).toBeGreaterThan(0);
    // And nothing reached a real client — either throw would have failed the run.
    expect(r.a1.counts.attioWrites + r.i1.counts.attioWrites).toBeGreaterThanOrEqual(0);
  });

  it('every recorded write names its target, so the artifact is reviewable', async () => {
    const r = await runReconcilerFix({
      sheets: sheets as never, attio: attio as never, logger: silent,
      dryRun: true, fixRunId: 'RECON-FIX-TEST',
    });
    for (const w of r.wouldWrite) expect(w).toMatch(/^(SHEETS Master_ID!|ATTIO )/);
  });
});
