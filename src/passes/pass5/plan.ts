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
 *
 * Overflow (2026-07-19, Bobby's own request): the per-bucket caps below
 * (3/4/4/3) and the global 10-item cap are BY DESIGN — deliberately keeping
 * the daily plan short enough not to be overwhelming. What shouldn't happen
 * is candidates beyond those caps just vanishing with no trace. Every
 * bucket-building function below now returns its FULL sorted candidate
 * list, uncapped — buildPlanItems applies the same caps as before (so its
 * output is byte-for-byte unchanged, safe for every existing test), and the
 * new buildOverflowItems uses the same full lists to surface everyone who
 * didn't make today's top 10, for Aida's "beyond today's 10" twirldown.
 * Deliberately NOT a second, separately-maintained copy of the bucket
 * filter/sort logic — that would be a real drift risk (change bucket 1's
 * sort in one place, forget the other). One definition of "what's a bucket
 * N candidate," two different things done with the result.
 *
 * Stalled-relationship visibility (2026-07-21, real bug found and fixed,
 * not a defensive guess): buildBucket3Full's candidate filter used to be
 * isSameOrBefore(nextCheckIn, today) alone. Traced directly against
 * cadence.ts (PASS 4): computeCadence's own "overdue catch-up" rule pushes
 * nextCheckIn forward to today + cadenceDays/2 for ANY overdue contact —
 * intentional, so the date doesn't pile up looking ever-more-overdue as
 * time passes uncorrected. But stalled (daysSince > 2*cadenceDays) always
 * implies overdue, so every stalled contact got this exact same
 * forward-push applied to nextCheckIn too. The precise code that computes
 * stalled=true is the same code that made a nextCheckIn-only filter blind
 * to them. Result: counts.ts's staleRelationships count (its own separate
 * r.stalled filter, unaffected by this bug) was always correct, while the
 * actual list — what a person could see or act on — silently never
 * included a relationship stalled badly enough to have already been
 * caught by the catch-up rule. Fixed with "|| r.stalled" in bucket 3's
 * filter below.
 */

import { diffDays, iso, isSameOrBefore, parseFlexibleDate, type CivilDate } from '../../lib/dates.js';
import type { CadenceRow, OpenTask, Pass5BrainCompleteRow, PlanItem, PlanItemType } from './types.js';

const REASON_TRUNCATE_LEN = 100;
const OVERDUE_PRIORITIES = new Set(['High', 'Urgent']);

/** Per-bucket caps for the PRIORITY plan (unchanged from the original spec numbers). */
const BUCKET_CAPS = { task: 3, reply: 4, outreach: 4, action: 3 } as const;

const PLAN_CAP = 10;
/**
 * Defensive size backstop, not an expected real-world ceiling. The
 * Daily_Brief write already refuses anything over its own 45k-char safety
 * margin (daily-brief-write.ts) regardless of this number — this just
 * avoids handing that guard an unreasonably large blob to reject on a truly
 * unusual day, and keeps Aida's twirldown from ever needing to render
 * hundreds of rows.
 */
const OVERFLOW_CAP = 40;

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

/** The dedup/overflow-exclusion key — same fallback rule everywhere: bhcId when present, else a type+contact pair. */
function itemKey(item: { bhcId: string; type: PlanItemType; contact: string }): string {
  return item.bhcId || `${item.type}:${item.contact}`;
}

// ─── Full (uncapped) bucket candidate lists — one definition, two uses ───────

function buildBucket1Full(openTasks: readonly OpenTask[], today: CivilDate): readonly Omit<PlanItem, 'priority'>[] {
  const overdue = openTasks
    .map((t) => {
      const due = parseFlexibleDate(t.dueDate);
      const daysOverdue = due ? diffDays(today, due) : -1;
      return { t, due, daysOverdue };
    })
    .filter((x) => x.daysOverdue > 0 && OVERDUE_PRIORITIES.has(x.t.priority));

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue); // days overdue desc

  return overdue.map(({ t, due }) => {
    // due is guaranteed non-null here — the filter above already required
    // daysOverdue > 0, which only happens when parseFlexibleDate succeeded.
    // Real bug found on a live run (2026-07-19): using the raw t.dueDate
    // string directly could surface a numeric Excel/Sheets date serial
    // (e.g. "46162") verbatim in Bobby-facing text instead of a real date,
    // when the underlying cell was stored/read as a number rather than an
    // ISO string. iso(due) always produces a clean YYYY-MM-DD regardless of
    // how the source cell was shaped.
    const dueDateDisplay = iso(due);
    return {
      ...blankItem('task', t.contactName, t.contactId, `Overdue since ${dueDateDisplay} — ${t.priority} priority`),
      description: t.description,
      taskId: t.taskId,
      dueDate: dueDateDisplay,
    };
  });
}

function buildBucket2Full(brainCompleteRows: readonly Pass5BrainCompleteRow[]): readonly Omit<PlanItem, 'priority'>[] {
  const pending = brainCompleteRows.filter((r) => r.actionRequired === 'REPLY_NEEDED');
  return pending.map((r) => ({
    ...blankItem('reply', r.contactName, r.bhcId, truncate(r.brainNotes || r.runningSummary, REASON_TRUNCATE_LEN)),
    channel: 'email',
    subject: r.subject,
    draft: r.responseDraft,
    replyRecipientsJson: r.replyRecipientsJson,
    replyMode: r.replyMode || 'individual',
  }));
}

function buildBucket3Full(cadenceResults: readonly CadenceRow[], today: CivilDate): readonly Omit<PlanItem, 'priority'>[] {
  // "|| r.stalled" is the actual fix here, not a defensive extra clause —
  // found by tracing cadence.ts directly, not assumed. computeCadence's own
  // "overdue catch-up" rule pushes nextCheckIn forward to today + cadenceDays/2
  // for ANY overdue contact, so the date doesn't just pile up looking
  // ever-more-overdue as time passes. But stalled (daysSince > 2*cadenceDays)
  // always implies overdue -- so every stalled contact gets this exact same
  // forward-push applied to nextCheckIn too. The precise code that flags
  // someone as stalled is the same code that hides them from a nextCheckIn-
  // only filter. Without this clause, a stalled relationship's
  // staleRelationships count (counts.ts, its own separate r.stalled filter)
  // would keep incrementing while the contact never once became a candidate
  // for the plan or the overflow twirldown -- correct count, invisible list.
  const due = cadenceResults.filter((r) => isSameOrBefore(r.nextCheckIn, today) || r.stalled);
  due.sort((a, b) => {
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1; // stalled desc
    const aDays = a.daysSince ?? -1;
    const bDays = b.daysSince ?? -1;
    return bDays - aDays; // days_since desc
  });

  return due.map((r) => ({
    ...blankItem('outreach', r.name ?? r.masterName ?? r.bhcId ?? r.recordId, r.bhcId ?? '', r.followUpReason),
    channel: (r.touchMode || 'email').toLowerCase(),
    attioRecordId: r.recordId,
  }));
}

function buildBucket4Full(brainCompleteRows: readonly Pass5BrainCompleteRow[]): readonly Omit<PlanItem, 'priority'>[] {
  const actionItems = brainCompleteRows.filter((r) => r.actionRequired === 'ACTION_ITEM');
  return actionItems.map((r) => ({
    ...blankItem('action', r.contactName, r.bhcId, truncate(r.runningSummary, REASON_TRUNCATE_LEN)),
    channel: 'email',
    subject: r.subject,
  }));
}

function fullBuckets(
  openTasks: readonly OpenTask[],
  brainCompleteRows: readonly Pass5BrainCompleteRow[],
  cadenceResults: readonly CadenceRow[],
  today: CivilDate,
): readonly (readonly Omit<PlanItem, 'priority'>[])[] {
  return [
    buildBucket1Full(openTasks, today),
    buildBucket2Full(brainCompleteRows),
    buildBucket3Full(cadenceResults, today),
    buildBucket4Full(brainCompleteRows),
  ];
}

const BUCKET_CAP_BY_INDEX = [BUCKET_CAPS.task, BUCKET_CAPS.reply, BUCKET_CAPS.outreach, BUCKET_CAPS.action];

/**
 * The daily plan — deliberately short, deliberately capped, unchanged in
 * every respect from before overflow existed. "Fill bucket slots in order,
 * dedup by bhcId (keep highest-priority item per contact)." Buckets are
 * already in priority order (1 before 2 before 3 before 4), so
 * first-occurrence-wins dedup is exactly "keep highest-priority."
 */
export function buildPlanItems(
  openTasks: readonly OpenTask[],
  brainCompleteRows: readonly Pass5BrainCompleteRow[],
  cadenceResults: readonly CadenceRow[],
  today: CivilDate,
): readonly PlanItem[] {
  const buckets = fullBuckets(openTasks, brainCompleteRows, cadenceResults, today).map((full, i) =>
    full.slice(0, BUCKET_CAP_BY_INDEX[i]),
  );

  const seen = new Set<string>();
  const merged: Omit<PlanItem, 'priority'>[] = [];
  for (const bucket of buckets) {
    for (const item of bucket) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return merged.slice(0, PLAN_CAP).map((item, i) => ({ ...item, priority: i + 1 }));
}

/**
 * Everyone who was a legitimate candidate for today but didn't end up in
 * `plan` — whether because their own bucket's cap (3/4/4/3) was already
 * full, or because the global 10-item cap cut them, or because a different
 * bucket already claimed that contact via cross-bucket dedup (e.g. a
 * contact with both an overdue task AND a reply-needed thread only ever
 * shows once in `plan`; their other item belongs here, not nowhere).
 *
 * Exclusion is by (type, bhcId), not bhcId alone — deliberately different
 * from buildPlanItems' own dedup. plan's dedup is correctly bhcId-only ("one
 * plan slot per contact, whichever's highest priority"), but overflow is
 * answering a different question: "is THIS SPECIFIC item — not just this
 * contact — already represented in the plan." A contact whose task claimed
 * their one plan slot still has a real, separate reply-needed item; using a
 * bhcId-only key here would wrongly treat that reply as "already accounted
 * for" and drop it too, defeating the entire point of this function.
 *
 * `planItems` must be the exact result of buildPlanItems for the same
 * inputs — the caller is responsible for that pairing, this function
 * doesn't recompute `plan` itself to guarantee there's exactly one
 * source of truth for what "already in the plan" means.
 */
export function buildOverflowItems(
  openTasks: readonly OpenTask[],
  brainCompleteRows: readonly Pass5BrainCompleteRow[],
  cadenceResults: readonly CadenceRow[],
  today: CivilDate,
  planItems: readonly PlanItem[],
): readonly PlanItem[] {
  const compoundKey = (item: { type: PlanItemType; bhcId: string; contact: string }) => `${item.type}:${itemKey(item)}`;
  const planKeys = new Set(planItems.map(compoundKey));
  const buckets = fullBuckets(openTasks, brainCompleteRows, cadenceResults, today);

  const seen = new Set<string>();
  const overflow: Omit<PlanItem, 'priority'>[] = [];
  for (const bucket of buckets) {
    for (const item of bucket) {
      const key = compoundKey(item);
      if (planKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      overflow.push(item);
      if (overflow.length >= OVERFLOW_CAP) break;
    }
    if (overflow.length >= OVERFLOW_CAP) break;
  }

  return overflow.map((item, i) => ({ ...item, priority: PLAN_CAP + i + 1 }));
}
