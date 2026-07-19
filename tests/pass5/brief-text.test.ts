import { describe, expect, it } from 'vitest';

import { buildBriefText } from '../../src/passes/pass5/brief-text.js';
import type { GamePlanCounts, MissionStatus, Pass5BrainCompleteRow, PlanItem } from '../../src/passes/pass5/types.js';

const ZERO_COUNTS: GamePlanCounts = { emailsPending: 0, tasksOverdue: 0, pipelineTouches: 0, staleRelationships: 0, meetingsToReview: 0 };
const EMPTY_TRACK = { active: 0, stalled: 0, nextTouch: null };
const EMPTY_MISSION: MissionStatus = { tnb: EMPTY_TRACK, fte: { ...EMPTY_TRACK, daysSinceTouch: null }, fractional: EMPTY_TRACK };

function brainRow(overrides: Partial<Pass5BrainCompleteRow> = {}): Pass5BrainCompleteRow {
  return {
    threadId: 'T1', bhcId: 'BHC-1', contactName: 'Alice', subject: '', runningSummary: '', brainNotes: '',
    actionRequired: 'REPLY_NEEDED', responseDraft: '', replyRecipientsJson: '', replyMode: '',
    ...overrides,
  };
}

describe('buildBriefText — all-clear', () => {
  it('uses the exact required text when every count is zero', () => {
    const brief = buildBriefText(ZERO_COUNTS, [], EMPTY_MISSION, null);
    expect(brief).toBe("Inbox clear. No urgent tasks or pipeline touches due today. Check back after tonight's Late Edition.");
  });

  it('is still the all-clear text even with a nonzero meetingsToReview (not one of the four all-clear signals)', () => {
    const brief = buildBriefText({ ...ZERO_COUNTS, meetingsToReview: 3 }, [], EMPTY_MISSION, null);
    expect(brief).toContain('Inbox clear');
  });
});

describe('buildBriefText — non-zero', () => {
  it('mentions the email count and contact names', () => {
    const counts = { ...ZERO_COUNTS, emailsPending: 2 };
    const rows = [brainRow({ contactName: 'Alice' }), brainRow({ contactName: 'Bob' })];
    const brief = buildBriefText(counts, rows, EMPTY_MISSION, null);
    expect(brief).toContain('2 emails need replies');
    expect(brief).toContain('Alice, Bob');
  });

  it('uses singular phrasing for exactly one pending email', () => {
    const counts = { ...ZERO_COUNTS, emailsPending: 1 };
    const brief = buildBriefText(counts, [brainRow({ contactName: 'Alice' })], EMPTY_MISSION, null);
    expect(brief).toContain('1 email needs a reply');
  });

  it('mentions overdue task count when nonzero', () => {
    const counts = { ...ZERO_COUNTS, tasksOverdue: 3 };
    const brief = buildBriefText(counts, [], EMPTY_MISSION, null);
    expect(brief).toContain('3 tasks are overdue');
  });

  it('ends with a "Start with" sentence when there is a top plan item', () => {
    const counts = { ...ZERO_COUNTS, emailsPending: 1 };
    const item: PlanItem = {
      type: 'reply', contact: 'Alice', bhcId: 'BHC-1', reason: 'needs a reply', channel: 'email', subject: '',
      draft: '', replyRecipientsJson: '', replyMode: '', description: '', taskId: '', dueDate: '', attioRecordId: '', priority: 1,
    };
    const brief = buildBriefText(counts, [brainRow()], EMPTY_MISSION, item);
    expect(brief).toContain('Start with Alice');
  });

  it('never contains markdown headers or bullets', () => {
    const counts = { ...ZERO_COUNTS, emailsPending: 1, tasksOverdue: 1 };
    const brief = buildBriefText(counts, [brainRow()], EMPTY_MISSION, null);
    expect(brief).not.toMatch(/^#/m);
    expect(brief).not.toMatch(/^[-*]\s/m);
  });
});
