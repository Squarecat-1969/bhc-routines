/**
 * Task-to-calendar matching, and the verdict.
 *
 * ⚠ COVERAGE, ADAPTED FROM THE SPEC'S §8 TO THIS SOURCE. §8 defines coverage
 * against Activity_Log. The calendar's analogue is the WINDOW: the calendar
 * sees every meeting inside it, so
 *
 *   · window covers the period since the task was created  → it could have
 *     seen the resolution. Nothing found means NO_EVIDENCE.
 *   · task predates the window start                       → the calendar was
 *     never going to speak to it. UNEVALUABLE.
 *
 * That is the same question §8 asks — "could the sources reasonably have seen
 * it?" — not a looser one. A task created three months ago against a 7-day
 * window is UNEVALUABLE, and calling it NO_EVIDENCE would assert staleness
 * from a window that never looked.
 */

import type { CandidateEvent, CalendarReconciliationResult, TaskKind } from './types.js';
import type { OpenTask } from '../pass2_5/types.js';

/**
 * "Schedule / plan a meeting with X" — the booking IS the completion.
 * Anything else is treated as a discussion task, where the meeting must have
 * HAPPENED and a calendar entry is only a hint.
 */
const SCHEDULING_RE = /\b(schedule|scheduling|set\s?up|book|arrange|plan|find\s+time|get\s+.*on\s+the\s+calendar)\b/i;

export function classifyTask(description: string): TaskKind {
  return SCHEDULING_RE.test(description) ? 'scheduling' : 'discussion';
}

/** ⚠ SUBJECT AND DATE ONLY. Never body text. */
export function buildEvidenceQuote(subject: string, startIso: string): string {
  return `"${subject}" on ${startIso.slice(0, 10)}`;
}

export interface MatchOptions {
  readonly windowStartIso: string;
  /** From the watermark: only events strictly newer than this are new information. */
  readonly lastEventSeen: string;
}

export function reconcileTask(
  task: OpenTask,
  candidates: readonly CandidateEvent[],
  opts: MatchOptions,
): CalendarReconciliationResult {
  const kind = classifyTask(task.description);
  const base = {
    taskId: task.taskId,
    source: 'sheet' as const,
    bhcId: task.contactId,
    contactName: task.contactName,
    description: task.description,
    taskKind: kind,
  };

  // Events involving this contact, at or after the task's creation. An event
  // BEFORE the task existed cannot have resolved it.
  const createdMs = Date.parse(task.createdAt);
  const forContact = candidates.filter((c) => {
    if (task.contactId === '' || !(c.byAddress.includes(task.contactId) || c.bySubject.includes(task.contactId))) return false;
    if (Number.isNaN(createdMs)) return true;
    const evMs = Date.parse(c.event.startIso);
    return Number.isNaN(evMs) || evMs >= createdMs;
  });

  const latestSeen = candidates.reduce((acc, c) => (c.event.startIso > acc ? c.event.startIso : acc), opts.lastEventSeen);

  if (forContact.length > 0) {
    const best = [...forContact].sort((a, b) => b.event.startIso.localeCompare(a.event.startIso))[0]!;
    // ⚠ A SCHEDULED MEETING IS NOT A HELD MEETING. The split is the whole
    // reason task kind is classified at all — one confidence level must not
    // cover both.
    const confidence = kind === 'scheduling' ? 'high' as const : 'medium' as const;
    const reasoning =
      kind === 'scheduling'
        ? `A calendar entry exists, and for a scheduling task the booking IS the completion.`
        : `A calendar entry exists, but a scheduled meeting is not a held meeting — this is a hint, not proof. A Fathom recording would confirm it.`;
    return {
      ...base,
      verdict: 'LIKELY_HANDLED_EVIDENCE',
      evidenceQuote: buildEvidenceQuote(best.event.subject, best.event.startIso),
      proposedCompletionDate: best.event.startIso.slice(0, 10),
      confidence,
      brainReasoning: reasoning,
      lastEventSeen: latestSeen,
    };
  }

  // Nothing matched. Which of the two "no" answers is it?
  const windowCoversTask = !Number.isNaN(createdMs) && Date.parse(opts.windowStartIso) <= createdMs;
  if (windowCoversTask) {
    return {
      ...base,
      verdict: 'NO_EVIDENCE',
      evidenceQuote: '',
      proposedCompletionDate: '',
      confidence: 'medium',
      brainReasoning: `The calendar window covers the period since this task was created and contains no meeting with this contact.`,
      lastEventSeen: latestSeen,
    };
  }
  return {
    ...base,
    verdict: 'UNEVALUABLE',
    evidenceQuote: '',
    proposedCompletionDate: '',
    confidence: '',
    brainReasoning: `The task predates the calendar window, so the calendar was never going to speak to it. Not stale — waiting for evidence to exist.`,
    lastEventSeen: latestSeen,
  };
}
