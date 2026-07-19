import { describe, expect, it } from 'vitest';

import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runPass5 } from '../../src/passes/pass5/index.js';
import type { CivilDate } from '../../src/lib/dates.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

const TODAY = '2026-07-19' as CivilDate;

const CONTACTS_HEADER = ['Contact_ID', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'Relationship_Tier'];

function taskRow(taskId: string, contactId: string, contactName: string, dueDate: string, priority: string): unknown[] {
  const row = new Array<unknown>(13).fill('');
  row[0] = taskId;
  row[1] = '2026-06-01';
  row[2] = contactId;
  row[4] = contactName;
  row[6] = 'A task';
  row[7] = dueDate;
  row[8] = 'Open';
  row[9] = priority;
  return row;
}

function brainRow(threadId: string, runId: string, bhcId: string, contactName: string, actionRequired: string): unknown[] {
  const row = new Array<unknown>(30).fill('');
  row[0] = threadId;
  row[1] = bhcId;
  row[2] = contactName;
  row[5] = 'Subject';
  row[10] = 'A summary';
  row[22] = actionRequired;
  row[27] = runId;
  return row;
}

const MINIMAL: FakeBackendConfig = {
  entries: [],
  people: {},
  masterId: [],
  contactsHeader: CONTACTS_HEADER,
  contacts: [],
};

async function run(config: Partial<FakeBackendConfig>, runId: string, dryRun: boolean) {
  const backend = new FakeBackend({ ...MINIMAL, ...config });
  const { sheetsUrl, attioBase } = await backend.start();
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  try {
    return await runPass5({ runId, dryRun }, { sheets, attio, logger: silentLogger, today: TODAY });
  } finally {
    await backend.stop();
  }
}

describe('PASS 5 orchestration — full assembly', () => {
  it('produces a game plan combining tasks, replies, and pipeline touches', async () => {
    const report = await run(
      {
        tasksOpen: [taskRow('T1', 'BHC-1', 'Alice', '2026-07-01', 'High')], // overdue
        brainComplete: [brainRow('THR-1', 'RUN-A', 'BHC-2', 'Bob', 'REPLY_NEEDED')],
        entries: [{ recordId: 'rec-carol', tnbStage: 'Stage 2 – Proposal Sent' }],
        people: { 'rec-carol': { name: 'Carol', bhcContactId: 'BHC-3', lastInteraction: '2026-04-01' } },
        masterId: [['BHC-3', 'Carol', 'ATTIO', '', 'rec-carol', '']],
      },
      'RUN-A',
      true,
    );

    expect(report.gamePlan).not.toBeNull();
    expect(report.gamePlan!.plan.length).toBeGreaterThan(0);
    const types = report.gamePlan!.plan.map((p) => p.type);
    expect(types).toContain('task');
    expect(types).toContain('reply');
  });

  it('only digests Brain_Complete rows for the specified run', async () => {
    const report = await run(
      {
        brainComplete: [
          brainRow('THR-1', 'RUN-A', 'BHC-1', 'Alice', 'REPLY_NEEDED'),
          brainRow('THR-2', 'RUN-OLD', 'BHC-2', 'Bob', 'REPLY_NEEDED'),
        ],
      },
      'RUN-A',
      true,
    );
    expect(report.brainCompleteRowCount).toBe(1);
  });
});

describe('PASS 5 orchestration — dry-run vs live', () => {
  it('dry-run computes the plan but does not write Daily_Brief', async () => {
    const report = await run({}, 'RUN-A', true);
    expect(report.gamePlan).not.toBeNull();
    expect(report.written).toBe(false);
  });

  it('live writes Daily_Brief', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl, attioBase } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    try {
      const report = await runPass5({ runId: 'RUN-A', dryRun: false }, { sheets, attio, logger: silentLogger, today: TODAY });
      expect(report.written).toBe(true);
      const write = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Daily_Brief'));
      expect(write).toBeDefined();
    } finally {
      await backend.stop();
    }
  });
});

describe('PASS 5 orchestration — all-clear', () => {
  it('produces the all-clear brief when nothing is actionable', async () => {
    const report = await run({}, 'RUN-A', true);
    expect(report.gamePlan!.brief).toContain('Inbox clear');
    expect(report.gamePlan!.plan).toHaveLength(0);
  });
});

describe('PASS 5 orchestration — fail-soft', () => {
  it('never throws — a Sheets failure is caught and reported as aborted, per spec 5g degrade-silently', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl, attioBase } = await backend.start();
    await backend.stop();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    const report = await runPass5({ runId: 'RUN-A', dryRun: true }, { sheets, attio, logger: silentLogger });
    expect(report.aborted).toBe(true);
  });
});
