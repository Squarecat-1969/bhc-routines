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
    const mainWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A2:AD2');
    expect(mainWrite).toBeDefined();
    const values = (mainWrite!.body as { values: unknown[][] }).values;
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
    const mainWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A2:AD1');
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
    expect((write.body as { range?: string }).range).toBe('Brain_Complete!A2:AD2');
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
