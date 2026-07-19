/**
 * Spec 5d. One real ambiguity resolved here, documented in
 * docs/pass5-notes.md: Buckets 1 and 3 each state their OWN specific sort
 * right in their definition ("sorted by days overdue desc" / "Sort by
 * (stalled desc, days_since desc)"), but a separate later paragraph titled
 * "Ranking" gives a different, more generic 3-key sort ("active pipeline
 * stage desc, days overdue desc, tier rank") that literally says "within
 * each bucket." Read together with "Fill bucket slots in order, dedup by
 * bhcId..., Assign priority 1-N sequentially after merging and trimming to
 * 10" immediately following it, the generic sort reads as the FINAL
 * cross-bucket assembly step, not a second per-bucket sort contradicting
 * the specific ones just given. Resolved as: each bucket's own explicit
 * sort governs which candidates fill that bucket's slots; the generic
 * 3-key rule's real work — dedup, trim, final priority numbering — happens
 * once across the merged pool.
 */

import { diffDays, isSameOrBefore, parseFlexibleDate, type CivilDate } from '../../lib/dates.js';
import type { CadenceRow, OpenTask, Pass5BrainCompleteRow, PlanItem, PlanItemType } from './types.js';

const REASON_TRUNCATE_LEN = 100;
const OVERDUE_PRIORITIES = new Set(['High', 'Urgent']);

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function blankItem(type: PlanItemType, contact: string, bhcId: string, reason: string): Omit<PlanItem, 'priority'> {
  return {
    type,
    contact,
    bhcId,
    reason,
    channel: null,
    subject: '',
    draft: '',
    replyRecipientsJson: '',
    replyMode: '',
    description: '',
    taskId: '',
    dueDate: '',
    attioRecordId: '',
  };
}

function buildBucket1(openTasks: readonly OpenTask[], today: CivilDate): readonly Omit<PlanItem, 'priority'>[] {
  const overdue = openTasks
    .map((t) => {
      const due = parseFlexibleDate(t.dueDate);
      const daysOverdue = due ? diffDays(today, due) : -1;
      return { t, daysOverdue };
    })
    .filter((x) => x.daysOverdue > 0 && OVERDUE_PRIORITIES.has(x.t.priority));

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue); // days overdue desc

  return overdue.slice(0, 3).map(({ t }) => ({
    ...blankItem('task', t.contactName, t.contactId, `Overdue since ${t.dueDate} — ${t.priority} priority`),
    description: t.description,
    taskId: t.taskId,
    dueDate: t.dueDate,
  }));
}

function buildBucket2(brainCompleteRows: readonly Pass5BrainCompleteRow[]): readonly Omit<PlanItem, 'priority'>[] {
  const pending = brainCompleteRows.filter((r) => r.actionRequired === 'REPLY_NEEDED');
  return pending.slice(0, 4).map((r) => ({
    ...blankItem('reply', r.contactName, r.bhcId, truncate(r.brainNotes || r.runningSummary, REASON_TRUNCATE_LEN)),
    channel: 'email',
    subject: r.subject,
    draft: r.responseDraft,
    replyRecipientsJson: r.replyRecipientsJson,
    replyMode: r.replyMode || 'individual',
  }));
}

function buildBucket3(cadenceResults: readonly CadenceRow[], today: CivilDate): readonly Omit<PlanItem, 'priority'>[] {
  const due = cadenceResults.filter((r) => isSameOrBefore(r.nextCheckIn, today));
  due.sort((a, b) => {
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1; // stalled desc
    const aDays = a.daysSince ?? -1;
    const bDays = b.daysSince ?? -1;
    return bDays - aDays; // days_since desc
  });

  return due.slice(0, 4).map((r) => ({
    ...blankItem('outreach', r.name ?? r.masterName ?? r.bhcId ?? r.recordId, r.bhcId ?? '', r.followUpReason),
    channel: (r.touchMode || 'email').toLowerCase(),
    attioRecordId: r.recordId,
  }));
}

function buildBucket4(brainCompleteRows: readonly Pass5BrainCompleteRow[]): readonly Omit<PlanItem, 'priority'>[] {
  const actionItems = brainCompleteRows.filter((r) => r.actionRequired === 'ACTION_ITEM');
  return actionItems.slice(0, 3).map((r) => ({
    ...blankItem('action', r.contactName, r.bhcId, truncate(r.runningSummary, REASON_TRUNCATE_LEN)),
    channel: 'email',
    subject: r.subject,
  }));
}

export function buildPlanItems(
  openTasks: readonly OpenTask[],
  brainCompleteRows: readonly Pass5BrainCompleteRow[],
  cadenceResults: readonly CadenceRow[],
  today: CivilDate,
): readonly PlanItem[] {
  const buckets = [
    buildBucket1(openTasks, today),
    buildBucket2(brainCompleteRows),
    buildBucket3(cadenceResults, today),
    buildBucket4(brainCompleteRows),
  ];

  // "Fill bucket slots in order, dedup by bhcId (keep highest-priority item
  // per contact)." Buckets are already in priority order (1 before 2 before
  // 3 before 4), so first-occurrence-wins dedup is exactly "keep
  // highest-priority."
  const seen = new Set<string>();
  const merged: Omit<PlanItem, 'priority'>[] = [];
  for (const bucket of buckets) {
    for (const item of bucket) {
      const key = item.bhcId || `${item.type}:${item.contact}`; // fall back to contact name when bhcId is blank
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return merged.slice(0, 10).map((item, i) => ({ ...item, priority: i + 1 }));
}
