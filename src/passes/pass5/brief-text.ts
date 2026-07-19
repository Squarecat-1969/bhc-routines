/**
 * Spec 5e. The zero-actionable case has exact required text. The non-zero
 * shape is given as an example template, not a rigid format string — built
 * here as plain sentences per the stated shape, with a sensible fallback
 * sentence for any individual count that happens to be zero while others
 * aren't (the spec only gives exact wording for the ALL-zero case).
 */

import type { GamePlanCounts, MissionStatus, Pass5BrainCompleteRow, PlanItem } from './types.js';

const ALL_CLEAR_BRIEF = "Inbox clear. No urgent tasks or pipeline touches due today. Check back after tonight's Late Edition.";

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function pipelineSentence(missionStatus: MissionStatus): string {
  const tracks: Array<[string, MissionStatus['tnb']]> = [
    ['TNB', missionStatus.tnb],
    ['FTE', missionStatus.fte],
    ['Fractional', missionStatus.fractional],
  ];
  const withActivity = tracks.filter(([, s]) => s.active > 0);
  if (withActivity.length === 0) return 'No active pipeline movement across TNB, FTE, or Fractional right now.';

  const parts = withActivity.map(([label, s]) => {
    if (s.stalled > 0) return `${label} has ${s.stalled} stalled`;
    if (s.nextTouch) return `${label}'s next touch is ${s.nextTouch}`;
    return `${label} has ${s.active} active`;
  });
  return `${parts.join('; ')}.`;
}

export function buildBriefText(
  counts: GamePlanCounts,
  brainCompleteRows: readonly Pass5BrainCompleteRow[],
  missionStatus: MissionStatus,
  topPlanItem: PlanItem | null,
): string {
  const allZero = counts.emailsPending === 0 && counts.tasksOverdue === 0 && counts.pipelineTouches === 0 && counts.staleRelationships === 0;
  if (allZero) return ALL_CLEAR_BRIEF;

  const sentences: string[] = [];

  if (counts.emailsPending > 0) {
    const names = brainCompleteRows
      .filter((r) => r.actionRequired === 'REPLY_NEEDED')
      .map((r) => r.contactName)
      .filter(Boolean)
      .slice(0, 4)
      .join(', ');
    sentences.push(
      `${counts.emailsPending} ${pluralize(counts.emailsPending, 'email needs a reply', 'emails need replies')}${names ? ` — ${names}` : ''}.`,
    );
  } else {
    sentences.push('No emails need a reply.');
  }

  if (counts.tasksOverdue > 0) {
    sentences.push(`${counts.tasksOverdue} ${pluralize(counts.tasksOverdue, 'task is', 'tasks are')} overdue.`);
  }

  sentences.push(pipelineSentence(missionStatus));

  if (topPlanItem) {
    sentences.push(`Start with ${topPlanItem.contact}${topPlanItem.reason ? ` — ${topPlanItem.reason}` : ''}.`);
  }

  return sentences.join(' ');
}
