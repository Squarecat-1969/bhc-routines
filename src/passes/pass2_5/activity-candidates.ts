/**
 * Spec 2.5c: "Search for completion evidence. Candidate qualifies only if ALL
 * hold: Contact matches (by BHC_ID, name, or email); Real interaction (NOT
 * Mark_Sent source or outreach beats); Not the originating interaction;
 * Dated on or after cluster's earliest Created_At; Content topically
 * satisfies the request — HARD GATE."
 *
 * This module handles every gate except the last one — topical satisfaction
 * is a semantic judgment call that needs the LLM (enrich.ts's sibling for
 * this pass). Everything here is deterministic pre-filtering: cut the
 * candidate list down before ever spending an API call on it.
 */

import { ACTIVITY_LOG_COLS, RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import { parseTimestampMs } from '../pass0/matching.js';
import type { ActivityLogCandidate, TaskCluster } from './types.js';

const ACTIVITY_LOG_FIRST_ROW = 2;

/** Real observed value: "Mark_Sent (Daily_Action_Growth)". Matched loosely — no confirmed exhaustive enum of automated-source values. */
const AUTOMATED_SOURCE_PATTERNS = [/mark_sent/i, /outreach/i, /\bbeat\b/i];

export async function loadActivityLogCandidates(sheets: SheetsClient): Promise<readonly ActivityLogCandidate[]> {
  const rows = await sheets.read(RANGES.activityLogData);
  const candidates: ActivityLogCandidate[] = [];

  rows.forEach((row, i) => {
    const activityId = cell(row, ACTIVITY_LOG_COLS.activityId);
    if (activityId === '') return;

    candidates.push({
      activityId,
      timestamp: cell(row, ACTIVITY_LOG_COLS.timestamp),
      contactId: cell(row, ACTIVITY_LOG_COLS.contactId),
      contactName: cell(row, ACTIVITY_LOG_COLS.contactName),
      channel: cell(row, 6), // G Channel
      direction: cell(row, 7), // H Direction
      subject: cell(row, 8), // I Subject
      body: cell(row, ACTIVITY_LOG_COLS.body),
      outcome: cell(row, ACTIVITY_LOG_COLS.outcome),
      source: cell(row, 16), // Q Source
      sheetRow: ACTIVITY_LOG_FIRST_ROW + i,
    });
  });

  return candidates;
}

function isAutomatedSource(source: string): boolean {
  return AUTOMATED_SOURCE_PATTERNS.some((re) => re.test(source));
}

/**
 * Applies every deterministic gate from spec 2.5c except topical
 * satisfaction. Returns candidates the LLM should actually consider —
 * cheaper and safer than sending the whole Activity_Log per task.
 */
export function filterCandidatesForCluster(
  cluster: TaskCluster,
  allCandidates: readonly ActivityLogCandidate[],
): readonly ActivityLogCandidate[] {
  const clusterStartMs = parseTimestampMs(cluster.earliestCreatedAt);
  const originatingIds = new Set(cluster.tasks.map((t) => t.relatedActivityId).filter((id) => id !== ''));

  return allCandidates.filter((c) => {
    // Contact matches (by BHC_ID or name — no email field on Activity_Log
    // candidates directly, so BHC_ID/name is what's actually available here).
    const contactMatches =
      (cluster.contactId !== '' && c.contactId === cluster.contactId) ||
      (cluster.contactName !== '' && c.contactName === cluster.contactName);
    if (!contactMatches) return false;

    if (isAutomatedSource(c.source)) return false;
    if (originatingIds.has(c.activityId)) return false;

    if (clusterStartMs !== null) {
      const candidateMs = parseTimestampMs(c.timestamp);
      if (candidateMs === null || candidateMs < clusterStartMs) return false;
    }

    return true;
  });
}
