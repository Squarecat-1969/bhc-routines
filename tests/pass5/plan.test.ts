import { describe, expect, it } from 'vitest';

import { buildOverflowItems, buildPlanItems } from '../../src/passes/pass5/plan.js';
import type { CadenceRow, OpenTask, Pass5BrainCompleteRow, Pass5PipelineProposal } from '../../src/passes/pass5/types.js';

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

function proposal(overrides: Partial<Pass5PipelineProposal> = {}): Pass5PipelineProposal {
  return {
    proposalId: 'PROP-abc12345', attioRecordId: 'rec-1', bhcId: 'BHC-9', contactName: 'Opp Person',
    companyName: 'Acme', evidence: 'Opportunity Emerging — re: demo call', proposedTrack: 'TNB', status: 'PENDING',
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
      [], [],
      TODAY);
    expect(items.map((i) => i.taskId)).toEqual(['T1']);
  });

  it('excludes a task due today or in the future (not yet overdue)', () => {
    const items = buildPlanItems([task({ taskId: 'T1', dueDate: '2026-07-19' })], [], [], [], TODAY);
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
      [], [],
      TODAY);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.taskId)).toEqual(['T2', 'T4', 'T3']);
  });

  it('formats the reason with due date and priority', () => {
    const items = buildPlanItems([task({ priority: 'Urgent', dueDate: '2026-07-01' })], [], [], [], TODAY);
    expect(items[0]!.reason).toBe('Overdue since 2026-07-01 — Urgent priority');
  });

  it('normalizes a numeric Excel/Sheets date serial to a real date, rather than leaking it verbatim — found on a real production run ("Overdue since 46162")', () => {
    // 46162 is a real Excel/Sheets serial (days since 1899-12-30) that
    // resolves to a date well before TODAY, matching the live bug: the
    // task's Due_Date cell was read/stored as a raw number instead of an
    // ISO string, and the raw value leaked straight into Bobby-facing text.
    const items = buildPlanItems([task({ priority: 'High', dueDate: '46162' })], [], [], [], TODAY);
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
    const items = buildPlanItems([], rows, [], [], TODAY);
    expect(items.filter((i) => i.type === 'reply')).toHaveLength(4);
  });

  it('carries the draft and reply recipients through', () => {
    const items = buildPlanItems([], [brainRow({ responseDraft: 'Hey there', replyRecipientsJson: '{"to":["a@x.com"]}' })], [], [], TODAY);
    expect(items[0]!.draft).toBe('Hey there');
    expect(items[0]!.replyRecipientsJson).toBe('{"to":["a@x.com"]}');
  });

  it('defaults replyMode to individual when blank', () => {
    const items = buildPlanItems([], [brainRow({ replyMode: '' })], [], [], TODAY);
    expect(items[0]!.replyMode).toBe('individual');
  });
});

describe('buildPlanItems — bucket 3: pipeline touches due', () => {
  it('only includes contacts whose next check-in is due', () => {
    const items = buildPlanItems(
      [],
      [],
      [cadenceRow({ recordId: '1', bhcId: 'BHC-1', nextCheckIn: '2026-07-19' as never }), cadenceRow({ recordId: '2', bhcId: 'BHC-2', nextCheckIn: '2026-07-25' as never })], [],
      TODAY);
    expect(items.filter((i) => i.type === 'outreach')).toHaveLength(1);
  });

  it('includes a stalled contact even when nextCheckIn is in the future — cadence.ts\'s own overdue-catch-up rule pushes every stalled contact\'s nextCheckIn forward, so a date-only filter would silently exclude exactly the relationships that need surfacing most', () => {
    const items = buildPlanItems(
      [],
      [],
      [
        cadenceRow({ recordId: '1', bhcId: 'BHC-1', name: 'PushedForwardButStalled', stalled: true, nextCheckIn: '2026-08-15' as never, daysSince: 200 }),
        cadenceRow({ recordId: '2', bhcId: 'BHC-2', name: 'NotDueNotStalled', stalled: false, nextCheckIn: '2026-08-15' as never }),
      ], [],
      TODAY);
    const outreach = items.filter((i) => i.type === 'outreach');
    expect(outreach.map((i) => i.contact)).toEqual(['PushedForwardButStalled']); // only the stalled one, not the merely-not-due one
  });

  it('sorts stalled first, then by days_since descending', () => {
    const items = buildPlanItems(
      [],
      [],
      [
        cadenceRow({ recordId: '1', bhcId: 'BHC-1', name: 'NotStalled', stalled: false, daysSince: 100 }),
        cadenceRow({ recordId: '2', bhcId: 'BHC-2', name: 'StalledLow', stalled: true, daysSince: 10 }),
        cadenceRow({ recordId: '3', bhcId: 'BHC-3', name: 'StalledHigh', stalled: true, daysSince: 50 }),
      ], [],
      TODAY);
    const outreach = items.filter((i) => i.type === 'outreach');
    expect(outreach.map((i) => i.contact)).toEqual(['StalledHigh', 'StalledLow', 'NotStalled']);
  });

  it('lowercases the channel from touchMode', () => {
    const items = buildPlanItems([], [], [cadenceRow({ touchMode: 'Social' })], [], TODAY);
    expect(items[0]!.channel).toBe('social');
  });
});

describe('buildPlanItems — bucket 4: action items', () => {
  it('only includes ACTION_ITEM rows, up to 3', () => {
    const rows = [1, 2, 3, 4].map((n) => brainRow({ threadId: `T${n}`, bhcId: `BHC-A${n}`, actionRequired: 'ACTION_ITEM' }));
    const items = buildPlanItems([], rows, [], [], TODAY);
    expect(items.filter((i) => i.type === 'action')).toHaveLength(3);
  });
});

describe('buildPlanItems — merge, dedup, trim, priority', () => {
  it('assigns sequential priority 1..N across the merged list', () => {
    const items = buildPlanItems(
      [task({ taskId: 'T1', contactId: 'BHC-1' })],
      [brainRow({ bhcId: 'BHC-2' })],
      [], [],
      TODAY);
    expect(items.map((i) => i.priority)).toEqual([1, 2]);
  });

  it('dedups by bhcId, keeping the first (highest-priority-bucket) occurrence', () => {
    const items = buildPlanItems(
      [task({ contactId: 'BHC-1', priority: 'High', dueDate: '2026-07-01' })], // bucket 1
      [brainRow({ bhcId: 'BHC-1', actionRequired: 'REPLY_NEEDED' })], // same contact, bucket 2
      [],
      [],
      TODAY,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('task'); // bucket 1 wins since it's filled first
  });

  it('trims to a maximum of 10 items total', () => {
    const rows = Array.from({ length: 20 }, (_, i) => brainRow({ threadId: `T${i}`, bhcId: `BHC-${i}`, actionRequired: 'REPLY_NEEDED' }));
    const items = buildPlanItems([], rows, [], [], TODAY);
    expect(items.length).toBeLessThanOrEqual(10);
  });
});

describe('buildOverflowItems', () => {
  it('is empty when every candidate fit inside its bucket cap and the plan', () => {
    const openTasks = [task({ taskId: 'T1', contactId: 'BHC-1', priority: 'High', dueDate: '2026-07-01' })];
    const plan = buildPlanItems(openTasks, [], [], [], TODAY);
    const overflow = buildOverflowItems(openTasks, [], [], [], TODAY, plan);
    expect(overflow).toHaveLength(0);
  });

  it("surfaces candidates beyond a bucket's own cap (bucket 2 caps at 4 replies)", () => {
    const rows = Array.from({ length: 6 }, (_, i) => brainRow({ threadId: `T${i}`, bhcId: `BHC-${i}`, contactName: `C${i}` }));
    const plan = buildPlanItems([], rows, [], [], TODAY);
    const overflow = buildOverflowItems([], rows, [], [], TODAY, plan);
    expect(plan.filter((i) => i.type === 'reply')).toHaveLength(4); // unchanged bucket cap
    expect(overflow.filter((i) => i.type === 'reply')).toHaveLength(2); // the 2 that didn't fit
    expect(overflow.map((i) => i.contact)).toEqual(['C4', 'C5']); // next in the same sort order
  });

  it('surfaces a stalled contact (with a future, catch-up-pushed nextCheckIn) in the overflow twirldown when crowded out of bucket 3\'s own 4-item cap — the actual point of the stalled-visibility fix: it is never simply invisible, worst case it lands here instead of the top 10', () => {
    const stalledRows = Array.from({ length: 5 }, (_, i) =>
      cadenceRow({ recordId: `${i}`, bhcId: `BHC-${i}`, name: `Stalled${i}`, stalled: true, nextCheckIn: '2026-09-01' as never, daysSince: 200 - i }),
    );
    const plan = buildPlanItems([], [], stalledRows, [], TODAY);
    const overflow = buildOverflowItems([], [], stalledRows, [], TODAY, plan);
    expect(plan.filter((i) => i.type === 'outreach')).toHaveLength(4); // bucket 3's own cap
    expect(overflow.filter((i) => i.type === 'outreach')).toHaveLength(1); // the 5th stalled contact — NOT dropped, just not in the top 10
  });

  it('surfaces a contact dropped by cross-bucket dedup, not silently — the exact scenario from the dedup test above', () => {
    const openTasks = [task({ contactId: 'BHC-1', priority: 'High', dueDate: '2026-07-01' })];
    const brainRows = [brainRow({ bhcId: 'BHC-1', actionRequired: 'REPLY_NEEDED' })];
    const plan = buildPlanItems(openTasks, brainRows, [], [], TODAY);
    const overflow = buildOverflowItems(openTasks, brainRows, [], [], TODAY, plan);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.type).toBe('task'); // bucket 1 claimed BHC-1's plan slot

    // BHC-1's reply-needed item didn't just disappear — it's in overflow,
    // not silently dropped, even though it was WITHIN bucket 2's own cap.
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.type).toBe('reply');
    expect(overflow[0]!.bhcId).toBe('BHC-1');
  });

  it("continues priority numbering from 11 onward, after the plan's 1..10", () => {
    const rows = Array.from({ length: 5 }, (_, i) => brainRow({ threadId: `T${i}`, bhcId: `BHC-${i}`, contactName: `C${i}` }));
    const plan = buildPlanItems([], rows, [], [], TODAY);
    const overflow = buildOverflowItems([], rows, [], [], TODAY, plan);
    expect(overflow.map((i) => i.priority)).toEqual([11]);
  });

  it("a contact's second, different-type need shows in overflow even when their first need made it into the plan", () => {
    // BHC-1 has a 5th-in-line reply (beyond bucket 2's 4-item cap) AND a
    // stale relationship (bucket 3). Bucket 2's cap excludes BHC-1's reply
    // from `plan`, but bucket 3 has no competing claim on BHC-1's bhcId yet
    // (plan's own dedup is bhcId-only, and nothing else claimed BHC-1
    // ahead of bucket 3) — so BHC-1's OUTREACH item legitimately ends up in
    // `plan`, and only the REPLY belongs in overflow. Verified by tracing
    // actual output, not assumed — this is the real, correct behavior of
    // plan's existing bhcId-only dedup rule, unchanged by this feature.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => brainRow({ threadId: `T${i}`, bhcId: `BHC-filler-${i}`, contactName: `C${i}` })),
      brainRow({ threadId: 'T-overflow', bhcId: 'BHC-1', contactName: 'Overflow Contact' }), // 5th reply
    ];
    const cadence = [cadenceRow({ bhcId: 'BHC-1', name: 'Overflow Contact', nextCheckIn: TODAY })];
    const plan = buildPlanItems([], rows, cadence, [], TODAY);
    const overflow = buildOverflowItems([], rows, cadence, [], TODAY, plan);

    expect(plan.filter((i) => i.bhcId === 'BHC-1').map((i) => i.type)).toEqual(['outreach']);
    expect(overflow.filter((i) => i.bhcId === 'BHC-1').map((i) => i.type)).toEqual(['reply']);
  });
});

// ── Bucket: opportunity proposals (PASS 4f -> Day Book) ────────────────────
describe('buildPlanItems — opportunity proposals', () => {
  it('maps a PENDING proposal onto the documented field shape', () => {
    const items = buildPlanItems([], [], [], [proposal()], TODAY);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.type).toBe('opportunity');
    expect(it0.contact).toBe('Opp Person');
    expect(it0.bhcId).toBe('BHC-9');
    expect(it0.reason).toBe('Opportunity Emerging — re: demo call'); // Evidence -> reason
    expect(it0.attioRecordId).toBe('rec-1');
    expect(it0.proposalId).toBe('PROP-abc12345');
    expect(it0.companyName).toBe('Acme');
    expect(it0.proposedTrack).toBe('TNB');
    // Not applicable to this type — and explicitly NOT overloaded.
    expect(it0.taskId).toBe('');
    expect(it0.channel).toBeNull();
    expect(it0.subject).toBe('');
    expect(it0.draft).toBe('');
    expect(it0.dueDate).toBe('');
  });

  it('NEVER puts the Proposal_ID in taskId — taskId means a Tasks_Open row', () => {
    const items = buildPlanItems([], [], [], [proposal({ proposalId: 'PROP-zzz' })], TODAY);
    expect(items[0]!.taskId).toBe('');
    expect(items[0]!.taskId).not.toBe('PROP-zzz');
  });

  it('includes only PENDING rows — accepted and rejected are done, not pending work', () => {
    const items = buildPlanItems([], [], [], [
      proposal({ proposalId: 'P1', bhcId: 'BHC-1', status: 'PENDING' }),
      proposal({ proposalId: 'P2', bhcId: 'BHC-2', status: 'ACCEPTED' }),
      proposal({ proposalId: 'P3', bhcId: 'BHC-3', status: 'REJECTED' }),
      proposal({ proposalId: 'P4', bhcId: 'BHC-4', status: '' }),
    ], TODAY);
    expect(items.map((i) => i.proposalId)).toEqual(['P1']);
  });

  it('tolerates lowercase/padded status without silently dropping a real proposal', () => {
    const items = buildPlanItems([], [], [], [proposal({ status: ' pending ' })], TODAY);
    expect(items).toHaveLength(1);
  });

  it('ranks BELOW overdue tasks and replies, ABOVE routine outreach', () => {
    const items = buildPlanItems(
      [task({ contactId: 'BHC-T', dueDate: '2026-07-01', priority: 'High' })],
      [brainRow({ bhcId: 'BHC-R', actionRequired: 'REPLY_NEEDED' })],
      [cadenceRow({ recordId: 'r-O', bhcId: 'BHC-O', nextCheckIn: '2026-07-01' as never })],
      [proposal({ bhcId: 'BHC-P' })],
      TODAY,
    );
    expect(items.map((i) => i.type)).toEqual(['task', 'reply', 'opportunity', 'outreach']);
  });

  it('caps the bucket at 3, and the rest fall through to overflow rather than vanishing', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      proposal({ proposalId: `P${i}`, bhcId: `BHC-${i}`, contactName: `Person ${i}` }),
    );
    const plan = buildPlanItems([], [], [], many, TODAY);
    expect(plan.filter((i) => i.type === 'opportunity')).toHaveLength(3);

    const overflow = buildOverflowItems([], [], [], many, TODAY, plan);
    const overflowOpps = overflow.filter((i) => i.type === 'opportunity');
    expect(overflowOpps).toHaveLength(3);
    // Every proposal is accounted for in exactly one of the two lists.
    const allIds = [...plan, ...overflow].filter((i) => i.type === 'opportunity').map((i) => i.proposalId);
    expect(new Set(allIds).size).toBe(6);
  });

  it('sorts deterministically by contact name — no invented urgency ranking', () => {
    const items = buildPlanItems([], [], [], [
      proposal({ proposalId: 'Pc', bhcId: 'BHC-c', contactName: 'Carol' }),
      proposal({ proposalId: 'Pa', bhcId: 'BHC-a', contactName: 'Alice' }),
      proposal({ proposalId: 'Pb', bhcId: 'BHC-b', contactName: 'Bob' }),
    ], TODAY);
    expect(items.map((i) => i.contact)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('changes nothing when there are no proposals — the other four buckets are untouched', () => {
    const args = [
      [task({ contactId: 'BHC-T', dueDate: '2026-07-01', priority: 'High' })],
      [brainRow({ bhcId: 'BHC-R' })],
      [cadenceRow({ recordId: 'r-O', bhcId: 'BHC-O', nextCheckIn: '2026-07-01' as never })],
    ] as const;
    const withNone = buildPlanItems(args[0], args[1], args[2], [], TODAY);
    expect(withNone.every((i) => i.type !== 'opportunity')).toBe(true);
    expect(withNone.map((i) => i.type)).toEqual(['task', 'reply', 'outreach']);
  });
});
