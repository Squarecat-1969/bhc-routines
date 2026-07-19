import { describe, expect, it } from 'vitest';

import { buildPlanItems } from '../../src/passes/pass5/plan.js';
import type { CadenceRow, OpenTask, Pass5BrainCompleteRow } from '../../src/passes/pass5/types.js';

const TODAY = '2026-07-19' as never;

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    taskId: 'T1', createdAt: '', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice', taskType: '',
    description: 'Send contract', dueDate: '2026-07-01', status: 'Open', priority: 'High', owner: '', closedAt: '',
    relatedActivityId: '', sheetRow: 2,
    ...overrides,
  };
}

function brainRow(overrides: Partial<Pass5BrainCompleteRow> = {}): Pass5BrainCompleteRow {
  return {
    threadId: 'T1', bhcId: 'BHC-1', contactName: 'Alice', subject: 'Hello', runningSummary: 'summary',
    brainNotes: '', actionRequired: 'REPLY_NEEDED', responseDraft: 'draft', replyRecipientsJson: '{}', replyMode: 'individual',
    ...overrides,
  };
}

function cadenceRow(overrides: Partial<CadenceRow> = {}): CadenceRow {
  return {
    recordId: '1', bhcId: 'BHC-1', name: 'Alice', masterName: null, tier: 'Strategic', tierDefaulted: false,
    activeStageNum: 1, activeTrack: 'TNB', activeStageLabel: 'Stage 1', cadenceDays: 90, touchMode: 'Context',
    reasonBase: '', lastTouch: null, nextCheckIn: '2026-07-19' as never, daysSince: null, stalled: false,
    followUpReason: 'follow up', overdueCatchUp: false, nameVerdict: null, attioBhcContactId: null, withheld: null, notes: [],
    ...overrides,
  };
}

describe('buildPlanItems — bucket 1: hard deadline tasks', () => {
  it('only includes High/Urgent priority overdue tasks', () => {
    const items = buildPlanItems(
      [task({ taskId: 'T1', priority: 'High', dueDate: '2026-07-01' }), task({ taskId: 'T2', priority: 'Low', dueDate: '2026-07-01' })],
      [],
      [],
      TODAY,
    );
    expect(items.map((i) => i.taskId)).toEqual(['T1']);
  });

  it('excludes a task due today or in the future (not yet overdue)', () => {
    const items = buildPlanItems([task({ taskId: 'T1', dueDate: '2026-07-19' })], [], [], TODAY);
    expect(items).toHaveLength(0);
  });

  it('sorts by days overdue descending and caps at 3', () => {
    const items = buildPlanItems(
      [
        task({ taskId: 'T1', contactId: 'BHC-1', dueDate: '2026-07-15' }), // 4 days
        task({ taskId: 'T2', contactId: 'BHC-2', dueDate: '2026-07-01' }), // 18 days
        task({ taskId: 'T3', contactId: 'BHC-3', dueDate: '2026-07-10' }), // 9 days
        task({ taskId: 'T4', contactId: 'BHC-4', dueDate: '2026-07-05' }), // 14 days
      ],
      [],
      [],
      TODAY,
    );
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.taskId)).toEqual(['T2', 'T4', 'T3']);
  });

  it('formats the reason with due date and priority', () => {
    const items = buildPlanItems([task({ priority: 'Urgent', dueDate: '2026-07-01' })], [], [], TODAY);
    expect(items[0]!.reason).toBe('Overdue since 2026-07-01 — Urgent priority');
  });

  it('normalizes a numeric Excel/Sheets date serial to a real date, rather than leaking it verbatim — found on a real production run ("Overdue since 46162")', () => {
    // 46162 is a real Excel/Sheets serial (days since 1899-12-30) that
    // resolves to a date well before TODAY, matching the live bug: the
    // task's Due_Date cell was read/stored as a raw number instead of an
    // ISO string, and the raw value leaked straight into Bobby-facing text.
    const items = buildPlanItems([task({ priority: 'High', dueDate: '46162' })], [], [], TODAY);
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).not.toContain('46162');
    expect(items[0]!.reason).toMatch(/Overdue since \d{4}-\d{2}-\d{2} — High priority/);
    expect(items[0]!.dueDate).not.toBe('46162');
    expect(items[0]!.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildPlanItems — bucket 2: reply-needed emails', () => {
  it('only includes REPLY_NEEDED rows, up to 4', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => brainRow({ threadId: `T${n}`, bhcId: `BHC-${n}`, contactName: `C${n}` }));
    const items = buildPlanItems([], rows, [], TODAY);
    expect(items.filter((i) => i.type === 'reply')).toHaveLength(4);
  });

  it('carries the draft and reply recipients through', () => {
    const items = buildPlanItems([], [brainRow({ responseDraft: 'Hey there', replyRecipientsJson: '{"to":["a@x.com"]}' })], [], TODAY);
    expect(items[0]!.draft).toBe('Hey there');
    expect(items[0]!.replyRecipientsJson).toBe('{"to":["a@x.com"]}');
  });

  it('defaults replyMode to individual when blank', () => {
    const items = buildPlanItems([], [brainRow({ replyMode: '' })], [], TODAY);
    expect(items[0]!.replyMode).toBe('individual');
  });
});

describe('buildPlanItems — bucket 3: pipeline touches due', () => {
  it('only includes contacts whose next check-in is due', () => {
    const items = buildPlanItems(
      [],
      [],
      [cadenceRow({ recordId: '1', bhcId: 'BHC-1', nextCheckIn: '2026-07-19' as never }), cadenceRow({ recordId: '2', bhcId: 'BHC-2', nextCheckIn: '2026-07-25' as never })],
      TODAY,
    );
    expect(items.filter((i) => i.type === 'outreach')).toHaveLength(1);
  });

  it('sorts stalled first, then by days_since descending', () => {
    const items = buildPlanItems(
      [],
      [],
      [
        cadenceRow({ recordId: '1', bhcId: 'BHC-1', name: 'NotStalled', stalled: false, daysSince: 100 }),
        cadenceRow({ recordId: '2', bhcId: 'BHC-2', name: 'StalledLow', stalled: true, daysSince: 10 }),
        cadenceRow({ recordId: '3', bhcId: 'BHC-3', name: 'StalledHigh', stalled: true, daysSince: 50 }),
      ],
      TODAY,
    );
    const outreach = items.filter((i) => i.type === 'outreach');
    expect(outreach.map((i) => i.contact)).toEqual(['StalledHigh', 'StalledLow', 'NotStalled']);
  });

  it('lowercases the channel from touchMode', () => {
    const items = buildPlanItems([], [], [cadenceRow({ touchMode: 'Social' })], TODAY);
    expect(items[0]!.channel).toBe('social');
  });
});

describe('buildPlanItems — bucket 4: action items', () => {
  it('only includes ACTION_ITEM rows, up to 3', () => {
    const rows = [1, 2, 3, 4].map((n) => brainRow({ threadId: `T${n}`, bhcId: `BHC-A${n}`, actionRequired: 'ACTION_ITEM' }));
    const items = buildPlanItems([], rows, [], TODAY);
    expect(items.filter((i) => i.type === 'action')).toHaveLength(3);
  });
});

describe('buildPlanItems — merge, dedup, trim, priority', () => {
  it('assigns sequential priority 1..N across the merged list', () => {
    const items = buildPlanItems(
      [task({ taskId: 'T1', contactId: 'BHC-1' })],
      [brainRow({ bhcId: 'BHC-2' })],
      [],
      TODAY,
    );
    expect(items.map((i) => i.priority)).toEqual([1, 2]);
  });

  it('dedups by bhcId, keeping the first (highest-priority-bucket) occurrence', () => {
    const items = buildPlanItems(
      [task({ contactId: 'BHC-1', priority: 'High', dueDate: '2026-07-01' })], // bucket 1
      [brainRow({ bhcId: 'BHC-1', actionRequired: 'REPLY_NEEDED' })], // same contact, bucket 2
      [],
      TODAY,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('task'); // bucket 1 wins since it's filled first
  });

  it('trims to a maximum of 10 items total', () => {
    const rows = Array.from({ length: 20 }, (_, i) => brainRow({ threadId: `T${i}`, bhcId: `BHC-${i}`, actionRequired: 'REPLY_NEEDED' }));
    const items = buildPlanItems([], rows, [], TODAY);
    expect(items.length).toBeLessThanOrEqual(10);
  });
});
