import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../../src/lib/anthropic.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runPass25 } from '../../src/passes/pass2_5/index.js';
import { FakeAnthropicBackend } from '../helpers/fake-anthropic.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

function taskRow(opts: { taskId: string; description?: string; dueDate?: string; relatedActivityId?: string }): unknown[] {
  const row = new Array<unknown>(13).fill('');
  row[0] = opts.taskId;
  row[1] = '2026-07-01T00:00:00Z';
  row[2] = 'BHC-1';
  row[4] = 'Alice';
  row[6] = opts.description ?? 'Send the contract';
  row[7] = opts.dueDate ?? '2026-07-25';
  row[8] = 'Open';
  row[9] = 'High';
  row[12] = opts.relatedActivityId ?? 'ACT-ORIGIN';
  return row;
}

function activityRow(opts: { activityId: string; timestamp: string; body: string; source?: string }): unknown[] {
  const row = new Array<unknown>(21).fill('');
  row[0] = opts.activityId;
  row[1] = opts.timestamp;
  row[2] = 'BHC-1';
  row[4] = 'Alice';
  row[9] = opts.body;
  row[16] = opts.source ?? 'orbit_work_queue';
  return row;
}

const MINIMAL: FakeBackendConfig = { entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [] };

async function run(sheetsConfig: Partial<FakeBackendConfig>, anthropicResponseText: string, dryRun: boolean, today = '2026-07-18') {
  const sheetsBackend = new FakeBackend({ ...MINIMAL, ...sheetsConfig });
  const { sheetsUrl } = await sheetsBackend.start();
  const anthropicBackend = new FakeAnthropicBackend({ responseText: anthropicResponseText });
  const { baseUrl: anthropicBase } = await anthropicBackend.start();

  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl: anthropicBase });

  try {
    const report = await runPass25({ dryRun, sheets, anthropic, logger: silentLogger, today: today as never });
    return { report, sheetsBackend, anthropicBackend };
  } finally {
    await sheetsBackend.stop();
    await anthropicBackend.stop();
  }
}

const EVIDENCE_FOUND = JSON.stringify({
  has_evidence: true,
  evidence_activity_id: 'ACT-2',
  evidence_quote: 'Signed and sent the contract back',
  confidence: 'high',
  brain_reasoning: 'Contact confirmed sending the signed contract.',
});

const NO_EVIDENCE = JSON.stringify({
  has_evidence: false,
  evidence_activity_id: '',
  evidence_quote: '',
  confidence: '',
  brain_reasoning: 'No matching interaction found in the candidates.',
});

describe('PASS 2.5 orchestration — evidence found', () => {
  it('resolves LIKELY_HANDLED_EVIDENCE and appends a new Reconciliation_Queue row', async () => {
    const { report, sheetsBackend } = await run(
      {
        tasksOpen: [taskRow({ taskId: 'T1' })],
        activityLog: [activityRow({ activityId: 'ACT-2', timestamp: '2026-07-10T00:00:00Z', body: 'Signed and sent the contract back' })],
      },
      EVIDENCE_FOUND,
      false,
    );
    expect(report.handledCount).toBe(1);
    expect(report.enqueuedCount).toBe(1);

    const append = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Reconciliation_Queue!A2:N');
    expect(append).toBeDefined();
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[7]).toBe('LIKELY_HANDLED_EVIDENCE');
    expect(row[9]).toBe('ACT-2'); // Evidence_Source
  });

  it('rejects a hallucinated evidence_activity_id not in the candidate list', async () => {
    const { report } = await run(
      {
        tasksOpen: [taskRow({ taskId: 'T1' })],
        activityLog: [activityRow({ activityId: 'ACT-2', timestamp: '2026-07-10T00:00:00Z', body: 'unrelated' })],
      },
      JSON.stringify({ has_evidence: true, evidence_activity_id: 'ACT-DOES-NOT-EXIST', evidence_quote: 'x', confidence: 'high', brain_reasoning: 'x' }),
      false,
    );
    expect(report.warnings.some((w) => w.includes('reconciliation failed'))).toBe(true);
    expect(report.handledCount).toBe(0);
  });
});

describe('PASS 2.5 orchestration — no evidence, date math decides STALE vs OPEN', () => {
  it('is GENUINELY_OPEN when the due date is recent/future', async () => {
    const { report } = await run(
      { tasksOpen: [taskRow({ taskId: 'T1', dueDate: '2026-07-25' })] }, // 7 days after "today" 2026-07-18
      NO_EVIDENCE,
      true,
    );
    expect(report.openCount).toBe(1);
    expect(report.staleCount).toBe(0);
  });

  it('is LIKELY_STALE_NO_EVIDENCE when the due date is more than 7 days past', async () => {
    const { report } = await run(
      { tasksOpen: [taskRow({ taskId: 'T1', dueDate: '2026-07-01' })] }, // 17 days before "today"
      NO_EVIDENCE,
      true,
    );
    expect(report.staleCount).toBe(1);
    expect(report.results[0]!.proposedCompletionDate).toBe('2026-07-01'); // spec: Proposed_Completion_Date = Due_Date
    expect(report.results[0]!.confidence).toBe('low');
  });

  it('skips the LLM call entirely when there are zero candidates', async () => {
    const { report, anthropicBackend } = await run(
      { tasksOpen: [taskRow({ taskId: 'T1' })] }, // no activityLog rows at all
      EVIDENCE_FOUND, // would be evidence if called — proves it wasn't
      true,
    );
    expect(anthropicBackend.requests).toHaveLength(0);
    expect(report.results[0]!.verdict).not.toBe('LIKELY_HANDLED_EVIDENCE');
  });
});

describe('PASS 2.5 orchestration — SUPERSEDE-IN-PLACE', () => {
  it('updates an existing awaiting row in place instead of appending a duplicate', async () => {
    const existingQueueRow = ['RECON-OLD', 'RUN-OLD', 'task', 'T1', 'BHC-1', 'Alice', 'Send the contract', 'GENUINELY_OPEN', '', '', '', '', 'old reasoning', ''];
    const { report, sheetsBackend } = await run(
      {
        tasksOpen: [taskRow({ taskId: 'T1', dueDate: '2026-07-01' })], // now stale
        reconciliationQueue: [existingQueueRow],
      },
      NO_EVIDENCE,
      false,
    );
    expect(report.supersededCount).toBe(1);
    expect(report.enqueuedCount).toBe(0);

    const update = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Reconciliation_Queue!A2:N2');
    expect(update).toBeDefined();
    const row = (update!.body as { values: unknown[][] }).values[0]!;
    expect(row[0]).toBe('RECON-OLD'); // same Recon_ID — in place, not a new one
    expect(row[7]).toBe('LIKELY_STALE_NO_EVIDENCE');
  });

  it('writes nothing when the new verdict is not a material change', async () => {
    const existingQueueRow = ['RECON-OLD', 'RUN-OLD', 'task', 'T1', 'BHC-1', 'Alice', 'Send the contract', 'GENUINELY_OPEN', '', '', '', '', 'old reasoning', ''];
    const { report, sheetsBackend } = await run(
      {
        tasksOpen: [taskRow({ taskId: 'T1', dueDate: '2026-07-25' })], // still not stale — same verdict as existing
        reconciliationQueue: [existingQueueRow],
      },
      NO_EVIDENCE,
      false,
    );
    expect(report.supersededCount).toBe(0);
    expect(report.enqueuedCount).toBe(0);
    const anyReconWrite = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Reconciliation_Queue'));
    expect(anyReconWrite).toBeUndefined();
  });

  it('does not supersede an already-resolved row (non-blank Status) — appends a new one instead', async () => {
    const resolvedRow = ['RECON-OLD', 'RUN-OLD', 'task', 'T1', 'BHC-1', 'Alice', 'Send the contract', 'GENUINELY_OPEN', '', '', '', '', 'old', 'ACCEPTED'];
    const { report } = await run(
      { tasksOpen: [taskRow({ taskId: 'T1', dueDate: '2026-07-01' })], reconciliationQueue: [resolvedRow] },
      NO_EVIDENCE,
      true,
    );
    expect(report.enqueuedCount).toBe(1);
    expect(report.supersededCount).toBe(0);
  });
});

describe('PASS 2.5 orchestration — dry-run', () => {
  it('still calls Anthropic but writes nothing to Sheets', async () => {
    const { sheetsBackend, anthropicBackend } = await run(
      {
        tasksOpen: [taskRow({ taskId: 'T1' })],
        activityLog: [activityRow({ activityId: 'ACT-2', timestamp: '2026-07-10T00:00:00Z', body: 'Signed and sent back' })],
      },
      EVIDENCE_FOUND,
      true,
    );
    expect(anthropicBackend.requests).toHaveLength(1);
    expect(sheetsBackend.sheetsWrites).toHaveLength(0);
  });
});

describe('PASS 2.5 orchestration — fail-soft', () => {
  it('never throws — a Sheets failure is caught and reported as aborted', async () => {
    const sheetsBackend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await sheetsBackend.start();
    await sheetsBackend.stop();
    const anthropicBackend = new FakeAnthropicBackend({ responseText: NO_EVIDENCE });
    const { baseUrl } = await anthropicBackend.start();

    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl });
    try {
      const report = await runPass25({ dryRun: true, sheets, anthropic, logger: silentLogger });
      expect(report.aborted).toBe(true);
    } finally {
      await anthropicBackend.stop();
    }
  }, 15_000);
});
