import { describe, expect, it } from 'vitest';

import { SheetsClient } from '../../src/lib/sheets.js';
import { loadBrainCompleteRowsForRun } from '../../src/passes/pass3/brain-complete-read.js';
import { buildTaskReconciliationLine, loadTaskReconciliationCountsForRun } from '../../src/passes/pass3/task-reconciliation-line.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

function brainRow(threadId: string, runId: string, slackMessage = ''): unknown[] {
  const row = new Array<unknown>(30).fill('');
  row[0] = threadId;
  row[22] = slackMessage ? 'REPLY_NEEDED' : 'NO_ACTION';
  row[26] = slackMessage;
  row[27] = runId;
  return row;
}

function reconRow(runId: string, verdict: string): unknown[] {
  return ['RECON-1', runId, 'task', 'T1', 'BHC-1', 'Alice', 'desc', verdict, '', '', '', '', '', ''];
}

const MINIMAL: FakeBackendConfig = { entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [] };

describe('loadBrainCompleteRowsForRun', () => {
  it('only returns rows matching the given Run_ID', async () => {
    const backend = new FakeBackend({
      ...MINIMAL,
      brainComplete: [brainRow('T1', 'RUN-A', '[1] x'), brainRow('T2', 'RUN-B'), brainRow('T3', 'RUN-A')],
    });
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      const rows = await loadBrainCompleteRowsForRun(sheets, 'RUN-A');
      expect(rows.map((r) => r.threadId)).toEqual(['T1', 'T3']);
    } finally {
      await backend.stop();
    }
  });
});

describe('loadTaskReconciliationCountsForRun', () => {
  it('counts verdicts only for the given Run_ID', async () => {
    const backend = new FakeBackend({
      ...MINIMAL,
      reconciliationQueue: [
        reconRow('RUN-A', 'LIKELY_HANDLED_EVIDENCE'),
        reconRow('RUN-A', 'LIKELY_STALE_NO_EVIDENCE'),
        reconRow('RUN-A', 'GENUINELY_OPEN'),
        reconRow('RUN-B', 'LIKELY_HANDLED_EVIDENCE'), // different run — excluded
      ],
    });
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      const counts = await loadTaskReconciliationCountsForRun(sheets, 'RUN-A');
      expect(counts).toEqual({ handled: 1, stale: 1, open: 1 });
    } finally {
      await backend.stop();
    }
  });
});

describe('buildTaskReconciliationLine', () => {
  it("matches spec 2.5f's exact wording", () => {
    const line = buildTaskReconciliationLine({ handled: 2, stale: 1, open: 3 });
    expect(line).toBe('🗂️ Task reconciliation: 2 likely handled · 1 likely stale · 3 still open — review & Accept/Deny in Aida. Nothing auto-closed.');
  });
});
