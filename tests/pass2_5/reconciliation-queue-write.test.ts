import { describe, expect, it } from 'vitest';

import {
  buildReconciliationQueueRow,
  findSupersedeTarget,
  isMaterialChange,
  type ExistingReconciliationRow,
} from '../../src/passes/pass2_5/reconciliation-queue-write.js';
import type { ReconciliationResult, TaskCluster } from '../../src/passes/pass2_5/types.js';

function existingRow(overrides: Partial<ExistingReconciliationRow> = {}): ExistingReconciliationRow {
  return {
    reconId: 'RECON-1', taskIds: ['T1'], verdict: 'GENUINELY_OPEN', evidenceQuote: '', confidence: '',
    proposedCompletionDate: '', status: '', sheetRow: 5,
    ...overrides,
  };
}

function result(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  const cluster: TaskCluster = {
    clusterKey: 'k', contactId: 'BHC-1', contactName: 'Alice', description: 'Send the contract',
    earliestCreatedAt: '2026-07-01', latestDueDate: '2026-07-10',
    tasks: [{ taskId: 'T1', createdAt: '2026-07-01', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice', taskType: '', description: 'Send the contract', dueDate: '2026-07-10', status: 'Open', priority: 'High', owner: 'Bobby', closedAt: '', relatedActivityId: '', sheetRow: 2 }],
  };
  return {
    cluster, verdict: 'GENUINELY_OPEN', evidenceQuote: '', evidenceSource: '', proposedCompletionDate: '',
    confidence: '', brainReasoning: 'Nothing yet.',
    ...overrides,
  };
}

describe('findSupersedeTarget', () => {
  it('finds an awaiting row whose Task_IDs overlap', () => {
    const existing = [existingRow({ taskIds: ['T1', 'T2'], status: '' })];
    expect(findSupersedeTarget(existing, ['T2'])?.reconId).toBe('RECON-1');
  });

  it('does not match a row already resolved (non-blank Status)', () => {
    const existing = [existingRow({ taskIds: ['T1'], status: 'ACCEPTED' })];
    expect(findSupersedeTarget(existing, ['T1'])).toBeNull();
  });

  it('does not match when Task_IDs do not overlap at all', () => {
    const existing = [existingRow({ taskIds: ['T9'], status: '' })];
    expect(findSupersedeTarget(existing, ['T1'])).toBeNull();
  });

  it('returns null when there is nothing to supersede', () => {
    expect(findSupersedeTarget([], ['T1'])).toBeNull();
  });
});

describe('isMaterialChange', () => {
  it('is false when nothing meaningful changed', () => {
    const existing = existingRow({ verdict: 'GENUINELY_OPEN', evidenceQuote: '', confidence: '', proposedCompletionDate: '' });
    expect(isMaterialChange(existing, result())).toBe(false);
  });

  it('is true when the verdict changed', () => {
    const existing = existingRow({ verdict: 'GENUINELY_OPEN' });
    expect(isMaterialChange(existing, result({ verdict: 'LIKELY_STALE_NO_EVIDENCE' }))).toBe(true);
  });

  it('is true when the evidence quote changed', () => {
    const existing = existingRow({ evidenceQuote: 'old quote' });
    expect(isMaterialChange(existing, result({ evidenceQuote: 'new quote' }))).toBe(true);
  });
});

describe('buildReconciliationQueueRow', () => {
  it('produces the exact 14-column A-N shape with Status blank', () => {
    const row = buildReconciliationQueueRow('RUN-1', 'RECON-1', result({ verdict: 'LIKELY_HANDLED_EVIDENCE', evidenceQuote: 'signed', evidenceSource: 'ACT-1', confidence: 'high' }));
    expect(row).toHaveLength(14);
    expect(row[0]).toBe('RECON-1');
    expect(row[1]).toBe('RUN-1');
    expect(row[2]).toBe('task');
    expect(row[3]).toBe('T1'); // comma-joined Task_IDs
    expect(row[13]).toBe(''); // Status — always blank, awaiting review
  });

  it('joins multiple task IDs with a comma', () => {
    const cluster: TaskCluster = {
      clusterKey: 'k', contactId: 'BHC-1', contactName: 'Alice', description: 'x',
      earliestCreatedAt: '', latestDueDate: '',
      tasks: [
        { taskId: 'T1', createdAt: '', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice', taskType: '', description: 'x', dueDate: '', status: 'Open', priority: '', owner: '', closedAt: '', relatedActivityId: '', sheetRow: 2 },
        { taskId: 'T2', createdAt: '', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice', taskType: '', description: 'x', dueDate: '', status: 'Open', priority: '', owner: '', closedAt: '', relatedActivityId: '', sheetRow: 3 },
      ],
    };
    const row = buildReconciliationQueueRow('RUN-1', 'RECON-1', result({ cluster }));
    expect(row[3]).toBe('T1,T2');
  });
});
