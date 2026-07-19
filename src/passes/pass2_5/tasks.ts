/**
 * Spec 2.5a: "Read Tasks_Open!A2:M. Keep rows where col I = Open."
 * Spec 2.5b: "Collapse duplicates into clusters. Same underlying request
 * across channels = ONE cluster. Distinct actions = separate clusters. When
 * in doubt, keep SEPARATE."
 *
 * Clustering is deliberately conservative: only merges tasks for the same
 * contact whose descriptions are near-identical after normalization. The
 * spec gives no algorithm and explicitly prefers under-merging ("when in
 * doubt, keep separate") — a fuzzy/ML-style similarity score would risk
 * merging genuinely distinct requests, which is the worse failure per the
 * spec's own stated preference.
 */

import { RANGES } from '../../config/constants.js';
import { iso, parseFlexibleDate, type CivilDate } from '../../lib/dates.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { OpenTask, TaskCluster } from './types.js';

const TASKS_OPEN_FIRST_ROW = 2;
const OPEN_STATUS = 'Open';

export async function loadOpenTasks(sheets: SheetsClient): Promise<readonly OpenTask[]> {
  const rows = await sheets.read(RANGES.tasksOpenData);
  const tasks: OpenTask[] = [];

  rows.forEach((row, i) => {
    const taskId = cell(row, 0);
    if (taskId === '') return; // blank trailing row
    const status = cell(row, 8);
    if (status !== OPEN_STATUS) return;

    tasks.push({
      taskId,
      createdAt: cell(row, 1),
      contactId: cell(row, 2),
      linkedinUrl: cell(row, 3),
      contactName: cell(row, 4),
      taskType: cell(row, 5),
      description: cell(row, 6),
      dueDate: cell(row, 7),
      status,
      priority: cell(row, 9),
      owner: cell(row, 10),
      closedAt: cell(row, 11),
      relatedActivityId: cell(row, 12),
      sheetRow: TASKS_OPEN_FIRST_ROW + i,
    });
  });

  return tasks;
}

/** Normalize for a conservative equality-style comparison: lowercase, strip punctuation, collapse whitespace. */
function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clusters by (contactId, normalized description). Two tasks only merge when
 * they're for the same contact AND their descriptions are identical after
 * normalization — genuinely "the same request," not "a similar request."
 * Everything else stays its own single-task cluster, per "when in doubt,
 * keep SEPARATE."
 */
export function clusterOpenTasks(tasks: readonly OpenTask[]): readonly TaskCluster[] {
  const groups = new Map<string, OpenTask[]>();

  for (const task of tasks) {
    const key = `${task.contactId || task.contactName}::${normalizeDescription(task.description)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  const clusters: TaskCluster[] = [];
  for (const [clusterKey, clusterTasks] of groups) {
    const sorted = [...clusterTasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = sorted[0]!;
    // Sort by actual parsed calendar date, not raw lexicographic string
    // order — the same numeric-Excel-serial bug found in PASS 5's plan
    // building (a raw serial like "46162" would otherwise rank after any
    // ISO string starting with "1" or "2" purely alphabetically, picking
    // the wrong "latest" due date and leaking the raw serial into
    // Reconciliation_Queue's Proposed_Completion_Date for Bobby to see).
    const parsedDueDates = sorted
      .map((t) => parseFlexibleDate(t.dueDate))
      .filter((d): d is CivilDate => d !== null);
    const latest = parsedDueDates.length > 0 ? parsedDueDates.sort().at(-1)! : null;

    clusters.push({
      clusterKey,
      tasks: sorted,
      contactId: first.contactId,
      contactName: first.contactName,
      description: first.description,
      earliestCreatedAt: first.createdAt,
      latestDueDate: iso(latest),
    });
  }

  return clusters;
}
