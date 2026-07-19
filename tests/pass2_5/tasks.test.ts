import { describe, expect, it } from 'vitest';

import { clusterOpenTasks, loadOpenTasks } from '../../src/passes/pass2_5/tasks.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';
import type { OpenTask } from '../../src/passes/pass2_5/types.js';

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    taskId: 'TASK-1', createdAt: '2026-07-01', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice',
    taskType: '', description: 'Send the contract', dueDate: '2026-07-10', status: 'Open', priority: 'High',
    owner: 'Bobby', closedAt: '', relatedActivityId: '', sheetRow: 2,
    ...overrides,
  };
}

function taskRow(opts: { taskId: string; contactId?: string; contactName?: string; description?: string; status?: string; createdAt?: string }): unknown[] {
  const row = new Array<unknown>(13).fill('');
  row[0] = opts.taskId;
  row[1] = opts.createdAt ?? '2026-07-01';
  row[2] = opts.contactId ?? 'BHC-1';
  row[4] = opts.contactName ?? 'Alice';
  row[6] = opts.description ?? 'Send the contract';
  row[7] = '2026-07-10';
  row[8] = opts.status ?? 'Open';
  return row;
}

describe('loadOpenTasks', () => {
  it('keeps only rows where Status is Open', async () => {
    const config: FakeBackendConfig = {
      entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [],
      tasksOpen: [taskRow({ taskId: 'T1', status: 'Open' }), taskRow({ taskId: 'T2', status: 'Closed' })],
    };
    const backend = new FakeBackend(config);
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      const tasks = await loadOpenTasks(sheets);
      expect(tasks.map((t) => t.taskId)).toEqual(['T1']);
    } finally {
      await backend.stop();
    }
  });
});

describe('clusterOpenTasks', () => {
  it('merges two tasks for the same contact with identical normalized descriptions', () => {
    const clusters = clusterOpenTasks([
      task({ taskId: 'T1', description: 'Send the contract' }),
      task({ taskId: 'T2', description: 'send the contract!' }), // same after normalization
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.tasks).toHaveLength(2);
  });

  it('keeps tasks separate for different contacts even with identical descriptions', () => {
    const clusters = clusterOpenTasks([
      task({ taskId: 'T1', contactId: 'BHC-1', description: 'Send the contract' }),
      task({ taskId: 'T2', contactId: 'BHC-2', description: 'Send the contract' }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('keeps tasks separate when descriptions merely resemble each other — when in doubt, keep SEPARATE', () => {
    const clusters = clusterOpenTasks([
      task({ taskId: 'T1', description: 'Send the contract' }),
      task({ taskId: 'T2', description: 'Send the invoice' }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('uses the earliest task as the representative and computes the latest due date', () => {
    const clusters = clusterOpenTasks([
      task({ taskId: 'T1', createdAt: '2026-07-05', dueDate: '2026-07-15' }),
      task({ taskId: 'T2', createdAt: '2026-07-01', dueDate: '2026-07-20' }),
    ]);
    expect(clusters[0]!.earliestCreatedAt).toBe('2026-07-01');
    expect(clusters[0]!.latestDueDate).toBe('2026-07-20');
  });
});
