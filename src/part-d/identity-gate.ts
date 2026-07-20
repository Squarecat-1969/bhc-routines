/**
 * The identity-verification gate, shared by write-row.ts (decides whether
 * to attempt a write) and qa-readback.ts (needs to independently know
 * whether a given write was even eligible to have been attempted, to
 * decide which read-back checks apply). One definition, not two — the same
 * principle used everywhere else a piece of logic is needed by more than
 * one caller in this pass.
 *
 * Added beyond a literal spec port — see write-row.ts's own module doc
 * comment for the full rationale (the June 12 corruption incident, and
 * Master_ID's own "never infer, always look up live" rule).
 */

import type { MasterIdIndex } from '../passes/pass4/load.js';

/** Returns null (safe to proceed) or a warning string explaining why the write should be withheld. */
export function verifyGoogleRowOwnership(masterId: MasterIdIndex, bhcId: string, claimedGoogleRow: number): string | null {
  const entry = masterId.byBhcId.get(bhcId);
  if (!entry) return `Master_ID has no entry for ${bhcId} — withholding Google write.`;
  if (entry.googleRow !== claimedGoogleRow) {
    return `Master_ID's Google_Row for ${bhcId} is ${entry.googleRow ?? '(none)'}, not the staged ${claimedGoogleRow} — Master_ID shifted since staging. Withholding Google write.`;
  }
  return null;
}

export function verifyAttioRecordOwnership(masterId: MasterIdIndex, bhcId: string, claimedRecordId: string): string | null {
  const entry = masterId.byBhcId.get(bhcId);
  if (!entry) return `Master_ID has no entry for ${bhcId} — withholding Attio write.`;
  if (entry.attioRecordId !== claimedRecordId) {
    return `Master_ID's Attio_Record_ID for ${bhcId} is ${entry.attioRecordId || '(none)'}, not the staged ${claimedRecordId} — Master_ID shifted since staging. Withholding Attio write.`;
  }
  return null;
}
