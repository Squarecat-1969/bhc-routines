import { describe, expect, it } from 'vitest';

import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runPass1 } from '../../src/passes/pass1/index.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

function brainCompleteRow(id: string, resolved: boolean): unknown[] {
  const row = new Array<unknown>(30).fill('');
  row[0] = id;
  row[21] = resolved;
  return row;
}

function threadStagingRow(id: string, status: string): unknown[] {
  const row = new Array<unknown>(23).fill('');
  row[0] = id;
  row[21] = status;
  return row;
}

const MINIMAL: FakeBackendConfig = {
  entries: [],
  people: {},
  masterId: [],
  contactsHeader: [],
  contacts: [],
};

async function run(config: Partial<FakeBackendConfig>, dryRun: boolean) {
  const backend = new FakeBackend({ ...MINIMAL, ...config });
  const { sheetsUrl } = await backend.start();
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  try {
    const report = await runPass1({ dryRun, sheets, logger: silentLogger });
    return { report, backend };
  } finally {
    await backend.stop();
  }
}

describe('PASS 1 — Brain_Complete housekeeping', () => {
  it('reports correct counts without writing anything in dry-run', async () => {
    const { report, backend } = await run(
      { brainComplete: [brainCompleteRow('BC1', true), brainCompleteRow('BC2', false)] },
      true,
    );
    expect(report.brainCompletePriorCount).toBe(2);
    expect(report.brainCompleteResolvedCount).toBe(1);
    expect(report.brainCompleteSurvivorCount).toBe(1);
    expect(backend.sheetsWrites).toHaveLength(0);
  });

  it('writes survivors back and blanks trailing rows in live mode', async () => {
    const { backend } = await run(
      {
        brainComplete: [
          brainCompleteRow('BC1', true),
          brainCompleteRow('BC2', false),
          brainCompleteRow('BC3', true),
        ],
      },
      false,
    );
    // The survivor write is a batchUpdate of one range — a verified
    // single-range write, so the blank below can be gated on its result.
    const mainWrite = backend.sheetsWrites.find(
      (w) => (w.body as { data?: { range: string }[] }).data?.[0]?.range === 'Brain_Complete!A2:AD2',
    );
    expect(mainWrite).toBeDefined();
    const values = (mainWrite!.body as { data: { values: unknown[][] }[] }).data[0]!.values;
    expect(values).toHaveLength(1);
    expect(values[0]![0]).toBe('BC2');

    const blankWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A3:AD4');
    expect(blankWrite).toBeDefined();
    expect((blankWrite!.body as { values: unknown[][] }).values).toHaveLength(2);
  });

  it('does not write a main block when every row is resolved (0 survivors), but still blanks trailing rows', async () => {
    const { report, backend } = await run(
      { brainComplete: [brainCompleteRow('BC1', true), brainCompleteRow('BC2', true)] },
      false,
    );
    expect(report.brainCompleteSurvivorCount).toBe(0);
    const mainWrite = backend.sheetsWrites.find(
      (w) => (w.body as { data?: { range: string }[] }).data?.[0]?.range === 'Brain_Complete!A2:AD1',
    );
    expect(mainWrite).toBeUndefined();
    const blankWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A2:AD3');
    expect(blankWrite).toBeDefined();
  });

  it('writes only the survivor row when nothing needs blanking (no unchanged-content shortcut)', async () => {
    const { backend } = await run({ brainComplete: [brainCompleteRow('BC1', false)] }, false);
    // Spec says "rewrite survivors back" unconditionally — no skip-if-unchanged
    // optimization, so the one survivor still gets written even though nothing
    // about it changed.
    expect(backend.sheetsWrites).toHaveLength(1);
    const write = backend.sheetsWrites[0]!;
    expect((write.body as { data: { range: string }[] }).data[0]!.range).toBe('Brain_Complete!A2:AD2');
  });

  it('writes truly nothing when Brain_Complete is empty to begin with', async () => {
    const { backend } = await run({ brainComplete: [] }, false);
    expect(backend.sheetsWrites).toHaveLength(0);
  });
});

describe('PASS 1 — Thread_Staging working set', () => {
  it('excludes PROCESSED rows from the working set', async () => {
    const { report } = await run(
      {
        threadStaging: [
          threadStagingRow('T1', 'PENDING'),
          threadStagingRow('T2', 'PROCESSED'),
          threadStagingRow('T3', 'ACTIVE'),
        ],
      },
      true,
    );
    expect(report.threadStagingTotalCount).toBe(3);
    expect(report.workingSet.map((r) => r.threadId)).toEqual(['T1', 'T3']);
  });

  it('never writes to Thread_Staging — PASS 1 only reads it', async () => {
    const { backend } = await run({ threadStaging: [threadStagingRow('T1', 'PENDING')] }, false);
    const threadStagingWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Thread_Staging'));
    expect(threadStagingWrite).toBeUndefined();
  });
});

describe('PASS 1 — fail-soft', () => {
  it('never throws — a failed Sheets read is caught and reported as aborted', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    await backend.stop(); // sabotage: server down before the pass starts
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });

    const report = await runPass1({ dryRun: true, sheets, logger: silentLogger });
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toBeTruthy();
  }, 15_000);
});

/**
 * THE BLANK IS CONDITIONAL ON A CONFIRMED SURVIVOR WRITE.
 *
 * This compaction's failure mode is DATA LOSS, not the omission most write
 * gaps here produce. Survivors are rewritten at the top, then the tail they
 * used to occupy is blanked. If the survivor write silently no-ops and the
 * blank proceeds, rows 2..newLastRow keep the OLD uncompacted content while
 * the tail — still holding the only copy of the real survivors — is erased.
 * Brain_Complete is the table Part D executes from.
 *
 * A stale uncompacted tab is recoverable next run. A blanked one is not.
 */
describe('PASS 1 — an unconfirmed survivor write never blanks the tail', () => {
  const threeRows = {
    brainComplete: [brainCompleteRow('BC1', true), brainCompleteRow('BC2', false), brainCompleteRow('BC3', true)],
  };

  const blankWriteIn = (backend: FakeBackend) =>
    backend.sheetsWrites.find((w) => String((w.body as { range?: string }).range ?? '').startsWith('Brain_Complete!A3'));

  it('REFUSED (0 cells written): leaves the tab uncompacted, blanks nothing, names the range', async () => {
    const { report, backend } = await run({ ...threeRows, batchUpdateZeroCellsFor: 'Brain_Complete' }, false);

    // The survivor write WAS issued...
    const attempted = backend.sheetsWrites.find(
      (w) => (w.body as { data?: { range: string }[] }).data?.[0]?.range === 'Brain_Complete!A2:AD2',
    );
    expect(attempted).toBeDefined();
    // ...and nothing was blanked, so the tail still holds the survivors.
    expect(blankWriteIn(backend)).toBeUndefined();

    const w = report.warnings.join('\n');
    expect(w).toContain('REFUSED');
    expect(w).toContain('Brain_Complete!A2:AD2');
    expect(w).toContain('NOT blanked');
    expect(w).toContain('safe to re-run');
  });

  it('UNVERIFIABLE (no totalUpdatedCells): also blanks nothing, and says so distinctly', async () => {
    const { report, backend } = await run({ ...threeRows, batchUpdateNoCellsFieldFor: 'Brain_Complete' }, false);

    expect(blankWriteIn(backend)).toBeUndefined();
    const w = report.warnings.join('\n');
    expect(w).toContain('UNVERIFIABLE');
    expect(w).toContain('NOT a refusal'); // the two layers stay apart
    expect(w).not.toContain('REFUSED');
    expect(w).toContain('Brain_Complete!A2:AD2');
  });

  it('CONFIRMED: blanks the tail exactly as before, with no warning', async () => {
    const { report, backend } = await run(threeRows, false);

    const blank = blankWriteIn(backend);
    expect(blank).toBeDefined();
    expect((blank!.body as { values: unknown[][] }).values).toHaveLength(2);
    expect(report.warnings.join('\n')).not.toContain('Brain_Complete survivor write');
  });
});
