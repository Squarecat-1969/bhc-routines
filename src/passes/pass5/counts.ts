/**
 * Spec 5c. Note the two date comparisons are deliberately different:
 * tasks_overdue uses strictly-before TODAY (a task due today isn't overdue
 * yet); pipeline_due uses on-or-before TODAY (a touch due today already
 * needs doing). Transcribed exactly as the spec's own pseudocode has it,
 * not normalized to match each other.
 */

import { isBefore, isSameOrBefore, parseFlexibleDate, type CivilDate } from '../../lib/dates.js';
import type { CadenceRow, GamePlanCounts, OpenTask, Pass5BrainCompleteRow } from './types.js';

export function computeCounts(
  brainCompleteRows: readonly Pass5BrainCompleteRow[],
  openTasks: readonly OpenTask[],
  cadenceResults: readonly CadenceRow[],
  meetingsToReviewCount: number,
  today: CivilDate,
): GamePlanCounts {
  const emailsPending = brainCompleteRows.filter((r) => r.actionRequired === 'REPLY_NEEDED').length;

  const tasksOverdue = openTasks.filter((t) => {
    const due = parseFlexibleDate(t.dueDate);
    return due !== null && isBefore(due, today);
  }).length;

  const pipelineTouches = cadenceResults.filter((r) => isSameOrBefore(r.nextCheckIn, today)).length;
  const staleRelationships = cadenceResults.filter((r) => r.stalled).length;

  return {
    emailsPending,
    tasksOverdue,
    pipelineTouches,
    staleRelationships,
    meetingsToReview: meetingsToReviewCount,
  };
}
