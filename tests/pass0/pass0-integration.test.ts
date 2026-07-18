import { describe, expect, it } from 'vitest';

import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runPass0 } from '../../src/passes/pass0/index.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

function activityLogRow(opts: {
  activityId: string;
  body?: string;
  nextActionNote?: string;
  contactId?: string;
  contactName?: string;
  timestamp?: string;
}): unknown[] {
  const row = new Array<unknown>(21).fill('');
  row[0] = opts.activityId;
  row[1] = opts.timestamp ?? '2026-07-15T12:00:00Z';
  row[2] = opts.contactId ?? 'BHC-00001';
  row[4] = opts.contactName ?? 'Alice Nguyen';
  row[9] = opts.body ?? '';
  row[15] = opts.nextActionNote ?? '';
  return row;
}

function threadStagingRow(opts: {
  threadId: string;
  contactName?: string;
  direction?: string;
  subject?: string;
  lastEmailDate?: string;
  status?: string;
}): unknown[] {
  const row = new Array<unknown>(23).fill('');
  row[0] = opts.threadId;
  row[2] = opts.contactName ?? 'Alice Nguyen';
  row[4] = opts.direction ?? 'Outbound';
  row[5] = opts.subject ?? 'Re: catching up';
  row[7] = opts.lastEmailDate ?? '2026-07-15T12:30:00Z';
  row[21] = opts.status ?? 'ACTIVE';
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
    const report = await runPass0({
      dryRun,
      sheets,
      logger: silentLogger,
      now: new Date('2026-07-18T00:00:00Z'),
    });
    return { report, backend };
  } finally {
    await backend.stop();
  }
}

describe('PASS 0 — EXACT Thread_ID match', () => {
  it('closes the placeholder live: body, outcome, and note cleared, thread marked PROCESSED', async () => {
    const { report, backend } = await run(
      {
        activityLog: [activityLogRow({ activityId: 'ACT-1', nextActionNote: 'PENDING_CAPTURE thread:T-1' })],
        threadStaging: [threadStagingRow({ threadId: 'T-1' })],
      },
      false,
    );
    expect(report.exactMatches).toHaveLength(1);

    const bodyWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!J2:J2');
    expect(bodyWrite).toBeDefined();
    const outcomeWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!N2:N2');
    expect((outcomeWrite!.body as { values: unknown[][] }).values[0]![0]).toBe('Replied');
    const noteWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!P2:P2');
    expect((noteWrite!.body as { values: unknown[][] }).values[0]![0]).toBe('');
    const threadWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Thread_Staging!U2:V2');
    expect((threadWrite!.body as { values: unknown[][] }).values[0]).toEqual(['recon:matched ACT-1', 'PROCESSED']);
  });

  it('writes nothing in dry-run', async () => {
    const { backend } = await run(
      {
        activityLog: [activityLogRow({ activityId: 'ACT-1', nextActionNote: 'PENDING_CAPTURE thread:T-1' })],
        threadStaging: [threadStagingRow({ threadId: 'T-1' })],
      },
      true,
    );
    expect(backend.sheetsWrites).toHaveLength(0);
  });
});

describe('PASS 0 — INFERRED (contact+72h) match', () => {
  it('enqueues to Reconciliation_Queue, never touches Activity_Log or Thread_Staging', async () => {
    const { report, backend } = await run(
      {
        activityLog: [activityLogRow({ activityId: 'ACT-1', body: '[PENDING_CAPTURE] draft', timestamp: '2026-07-15T12:00:00Z' })],
        threadStaging: [threadStagingRow({ threadId: 'T-1', contactName: 'Alice Nguyen', lastEmailDate: '2026-07-15T13:00:00Z' })],
      },
      false,
    );
    expect(report.inferredMatches).toHaveLength(1);

    const enqueue = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Reconciliation_Queue!A2:N');
    expect(enqueue).toBeDefined();
    const row = (enqueue!.body as { values: unknown[][] }).values[0]!;
    expect(row[2]).toBe('placeholder_reconciliation'); // C Item_Type
    expect(row[3]).toBe(''); // D Source_Task_ID — blank, not a task
    expect(row[4]).toBe('BHC-00001'); // E BHC_ID
    expect(row[13]).toBe(''); // N Status — awaiting

    const activityLogWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Activity_Log'));
    expect(activityLogWrite).toBeUndefined();
    const threadStagingWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Thread_Staging'));
    expect(threadStagingWrite).toBeUndefined();
  });
});

describe('PASS 0 — AMBIGUOUS match', () => {
  it('tags every ambiguous candidate, writes nothing to Activity_Log', async () => {
    const { report, backend } = await run(
      {
        activityLog: [activityLogRow({ activityId: 'ACT-1', body: '[PENDING_CAPTURE] draft', timestamp: '2026-07-15T12:00:00Z' })],
        threadStaging: [
          threadStagingRow({ threadId: 'T-1', lastEmailDate: '2026-07-15T13:00:00Z' }),
          threadStagingRow({ threadId: 'T-2', lastEmailDate: '2026-07-15T14:00:00Z' }),
        ],
      },
      false,
    );
    expect(report.ambiguousCount).toBe(1);

    const tags = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Thread_Staging!U'));
    expect(tags).toHaveLength(2);
    for (const t of tags) {
      expect((t.body as { values: unknown[][] }).values[0]![0]).toBe('recon:ambiguous');
    }
    // Row_Status is NOT touched for ambiguous — only U (Brain_Notes), never V.
    const statusWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.includes('V2') || (w.body as { range?: string }).range?.includes('V3'));
    expect(statusWrites).toHaveLength(0);

    const activityLogWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Activity_Log'));
    expect(activityLogWrite).toBeUndefined();
  });
});

describe('PASS 0 — NO_MATCH and staleness', () => {
  it('writes nothing for a placeholder with no candidate at all', async () => {
    const { report, backend } = await run(
      { activityLog: [activityLogRow({ activityId: 'ACT-1', body: '[PENDING_CAPTURE] draft' })] },
      false,
    );
    expect(report.noMatchCount).toBe(1);
    expect(backend.sheetsWrites).toHaveLength(0);
  });

  it('reports (but does not write) a stale placeholder older than 7 days', async () => {
    const { report } = await run(
      {
        activityLog: [
          activityLogRow({ activityId: 'ACT-OLD', body: '[PENDING_CAPTURE] draft', timestamp: '2026-07-01T00:00:00Z' }),
        ],
      },
      false,
    );
    expect(report.stalePlaceholderCount).toBe(1);
    expect(report.warnings.some((w) => w.includes('ACT-OLD'))).toBe(true);
  });
});

describe('PASS 0 — fail-soft', () => {
  it('never throws — a Sheets failure is caught and reported as aborted', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    await backend.stop();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });

    const report = await runPass0({ dryRun: true, sheets, logger: silentLogger });
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toBeTruthy();
  }, 15_000);
});
