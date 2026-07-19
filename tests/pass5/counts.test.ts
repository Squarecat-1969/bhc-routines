import { describe, expect, it } from 'vitest';

import { computeCounts } from '../../src/passes/pass5/counts.js';
import type { CadenceRow, OpenTask, Pass5BrainCompleteRow } from '../../src/passes/pass5/types.js';

const TODAY = '2026-07-19' as never;

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    taskId: 'T1', createdAt: '', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice', taskType: '',
    description: '', dueDate: '2026-07-25', status: 'Open', priority: 'High', owner: '', closedAt: '',
    relatedActivityId: '', sheetRow: 2,
    ...overrides,
  };
}

function brainRow(overrides: Partial<Pass5BrainCompleteRow> = {}): Pass5BrainCompleteRow {
  return {
    threadId: 'T1', bhcId: 'BHC-1', contactName: 'Alice', subject: '', runningSummary: '', brainNotes: '',
    actionRequired: 'NO_ACTION', responseDraft: '', replyRecipientsJson: '', replyMode: '',
    ...overrides,
  };
}

function cadenceRow(overrides: Partial<CadenceRow> = {}): CadenceRow {
  return {
    recordId: '1', bhcId: 'BHC-1', name: 'Alice', masterName: null, tier: 'Strategic', tierDefaulted: false,
    activeStageNum: 1, activeTrack: 'TNB', activeStageLabel: 'Stage 1', cadenceDays: 90, touchMode: 'Context',
    reasonBase: '', lastTouch: null, nextCheckIn: '2026-07-19' as never, daysSince: null, stalled: false,
    followUpReason: '', overdueCatchUp: false, nameVerdict: null, attioBhcContactId: null, withheld: null, notes: [],
    ...overrides,
  };
}

describe('computeCounts', () => {
  it('counts emailsPending from REPLY_NEEDED rows only', () => {
    const counts = computeCounts([brainRow({ actionRequired: 'REPLY_NEEDED' }), brainRow({ actionRequired: 'FYI_ONLY' })], [], [], 0, TODAY);
    expect(counts.emailsPending).toBe(1);
  });

  it('counts tasksOverdue using strictly-before today (a task due today is not yet overdue)', () => {
    const counts = computeCounts([], [task({ dueDate: '2026-07-19' }), task({ dueDate: '2026-07-18' })], [], 0, TODAY);
    expect(counts.tasksOverdue).toBe(1); // only the 07-18 one
  });

  it('counts pipelineTouches using on-or-before today (due today already counts)', () => {
    const counts = computeCounts([], [], [cadenceRow({ nextCheckIn: '2026-07-19' as never }), cadenceRow({ nextCheckIn: '2026-07-20' as never })], 0, TODAY);
    expect(counts.pipelineTouches).toBe(1); // only the 07-19 one
  });

  it('counts staleRelationships from the stalled flag', () => {
    const counts = computeCounts([], [], [cadenceRow({ stalled: true }), cadenceRow({ stalled: false })], 0, TODAY);
    expect(counts.staleRelationships).toBe(1);
  });

  it('passes meetingsToReview through unchanged', () => {
    const counts = computeCounts([], [], [], 7, TODAY);
    expect(counts.meetingsToReview).toBe(7);
  });
});
