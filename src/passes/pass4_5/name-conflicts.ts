/**
 * PASS 4.5h — ATTIO-only name-conflict classification and suppression.
 *
 * Pure logic, no I/O. Two independent questions, asked in this order:
 *   1. classifyNameDrift — given old (Master_ID) vs new (Attio) names, is this
 *      an exact match (nothing to do), a candidate worth a review card, or
 *      something to leave alone for the Reconciler's broader sweep?
 *   2. shouldSuppress — given a candidate, has this exact old→new transition
 *      already been resolved (or is already awaiting) in Name_Conflicts?
 */

import { verifyName } from '../../lib/name-verify.js';
import type { NameDriftVerdict } from './types.js';

/**
 * Spec 4.5h gate:
 *   - Exact match (case-sensitive, outer-trim only) → EXACT, no card.
 *   - Non-exact but sharing ≥1 significant word → CANDIDATE for Name_Conflicts.
 *   - Zero significant words in common → LEAVE_FOR_RECONCILER (that's Reconciler
 *     A5's job, not raised here).
 *
 * Note this is deliberately NOT `verifyName`'s MATCH/MISMATCH framing reused
 * verbatim: here a *word-level* match is the CANDIDATE case (something changed
 * enough to ask about), and only literal equality skips the card entirely.
 * `verifyName` still supplies the significant-word overlap check itself, so
 * every routine agrees on what "shares a word" means (Reconciler_Fix Step 1.5).
 */
export function classifyNameDrift(oldName: string, newName: string): NameDriftVerdict {
  const oldTrimmed = oldName.trim();
  const newTrimmed = newName.trim();

  if (oldTrimmed === newTrimmed) return 'EXACT';

  const check = verifyName(newTrimmed, oldTrimmed);
  if (check.verdict === 'MATCH') return 'CANDIDATE';
  // MISMATCH (zero shared significant words) and UNVERIFIABLE (a name missing,
  // or neither name has any significant word left after normalization) both
  // fall through to the Reconciler rather than raising a card we can't back
  // with a confident comparison.
  return 'LEAVE_FOR_RECONCILER';
}

export type NameConflictStatus = 'RESOLVED_OLD' | 'RESOLVED_NEW' | '' | string;

export interface ExistingNameConflictRow {
  readonly bhcId: string;
  readonly oldName: string;
  readonly newName: string;
  readonly status: NameConflictStatus;
}

/**
 * Spec 4.5h suppression, keyed on (BHC_ID, old, new):
 *   - A RESOLVED_OLD row for that key exists → suppress (permanent "keep current").
 *   - An awaiting row (blank Status) for that key exists → skip (no duplicate).
 *   - A RESOLVED_NEW row for that key exists → re-raise (drifted back) → enqueue.
 *   - Otherwise (no matching row at all) → enqueue.
 *
 * These checks are independent, not mutually exclusive matches on the same row
 * — evaluated in the order the spec lists them.
 */
export function shouldEnqueue(
  candidate: { bhcId: string; oldName: string; newName: string },
  existingRows: readonly ExistingNameConflictRow[],
): boolean {
  const forKey = existingRows.filter(
    (r) => r.bhcId === candidate.bhcId && r.oldName === candidate.oldName && r.newName === candidate.newName,
  );

  if (forKey.some((r) => r.status === 'RESOLVED_OLD')) return false; // suppressed
  if (forKey.some((r) => r.status === '')) return false; // already awaiting, no duplicate
  // RESOLVED_NEW present, or no matching row at all: both enqueue.
  return true;
}
