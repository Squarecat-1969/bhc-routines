/**
 * Name_Conflicts suppression, keyed on (BHC_ID, old, new) against one read of
 * Name_Conflicts!A:M taken at the top of PASS 4.
 *
 *   RESOLVED_OLD -> suppress permanently. "Keep current" is a decision, and
 *                   re-nagging every week would relitigate it forever.
 *   RESOLVED_NEW -> re-raise. The name drifted BACK, which is new information.
 *   blank/other  -> already queued, skip (no duplicate).
 */

import { cell } from '../../lib/sheets.js';
import type { NameConflictCandidate } from './types.js';

const COL = { bhcId: 3, oldName: 5, newName: 6, status: 10 } as const;

export type SuppressionOutcome =
  | 'enqueue'
  | 'suppressed_resolved_old'
  | 'skipped_awaiting'
  | 're_raised_resolved_new';

export interface SuppressionDecision {
  readonly candidate: NameConflictCandidate;
  readonly outcome: SuppressionOutcome;
}

function key(bhcId: string, oldName: string, newName: string): string {
  return `${bhcId}|${oldName.trim()}|${newName.trim()}`;
}

export function applySuppression(
  candidates: readonly NameConflictCandidate[],
  existingRows: readonly (readonly unknown[])[],
): readonly SuppressionDecision[] {
  const byKey = new Map<string, string[]>();
  for (const r of existingRows) {
    const k = key(cell(r, COL.bhcId), cell(r, COL.oldName), cell(r, COL.newName));
    byKey.set(k, [...(byKey.get(k) ?? []), cell(r, COL.status).trim().toUpperCase()]);
  }

  return candidates.map((c) => {
    const statuses = byKey.get(key(c.bhcId, c.oldName, c.newName)) ?? [];
    if (statuses.includes('RESOLVED_OLD')) {
      return { candidate: c, outcome: 'suppressed_resolved_old' as const };
    }
    if (statuses.includes('RESOLVED_NEW')) {
      return { candidate: c, outcome: 're_raised_resolved_new' as const };
    }
    if (statuses.length > 0) {
      // An awaiting row (blank status) or anything else already queued.
      return { candidate: c, outcome: 'skipped_awaiting' as const };
    }
    return { candidate: c, outcome: 'enqueue' as const };
  });
}

export function shouldWrite(d: SuppressionDecision): boolean {
  return d.outcome === 'enqueue' || d.outcome === 're_raised_resolved_new';
}

/** The 13-column A:M enqueue row. */
export function toNameConflictRow(
  c: NameConflictCandidate,
  opts: { runId: string; conflictId: string; detectedAt: string },
): readonly unknown[] {
  return [
    opts.conflictId, opts.runId, 'RECONCILER', c.bhcId, 'BOTH',
    c.oldName, c.newName, 'Attio', 'Google',
    JSON.stringify({ google_row: c.googleRow, attio_record_id: c.attioRecordId, master_row: c.masterRow }),
    '',
    opts.detectedAt,
    'BOTH name drift (Reconciler I1)',
  ];
}
