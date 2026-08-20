/**
 * Reconciler Fix - the name-verification gate. PHASE 1: pure logic only.
 *
 * PASS 4 Step 1.5 and PASS 6.5 Step 1.5; the spec says the second is "reused
 * verbatim" from the first, so there is one implementation.
 *
 * This gate is the guardrail whose ABSENCE corrupted ~82 records in June 2026:
 * writing to an Attio record whose pointer had drifted to a different person
 * makes the corruption worse, not better. Non-negotiable 8: an ID-string match
 * alone is not sufficient to confirm you are writing to the right person.
 *
 * NO FETCH INSIDE. It judges two strings already in hand; the orchestration
 * that fetches the Attio record belongs to a later phase.
 */

import { verifyName, type NameVerdict } from '../../lib/name-verify.js';

export type GateDecision = 'PROCEED' | 'NEEDS_MANUAL';

export interface NameGateResult {
  readonly decision: GateDecision;
  /** MATCH / MISMATCH / UNVERIFIABLE - the three cases the spec distinguishes. */
  readonly verdict: NameVerdict;
  /** Human-readable, suitable for the Master_ID Notes append in a later phase. */
  readonly reason: string;
  readonly sharedWords: readonly string[];
}

/**
 * At least ONE significant word in common, particles excluded.
 *
 * Delegates to lib/name-verify.ts's verifyName rather than reimplementing:
 * that function's own doc comment states its semantics are lifted verbatim from
 * this very spec's Step 1.5, and it already distinguishes the three outcomes
 * the spec needs - MATCH, MISMATCH (zero words), and UNVERIFIABLE (no name to
 * check). Rebuilding it here would create exactly the second, drifting copy
 * that the June 2026 incident argues against.
 *
 * Both failure modes return NEEDS_MANUAL, but with DIFFERENT reasons, because
 * the spec writes a different note for each: a mismatch says the pointer may
 * reference the wrong person; an absent name says it could not be verified.
 */
export function nameGate(
  attioName: string | null | undefined,
  masterFullName: string | null | undefined,
): NameGateResult {
  const check = verifyName(attioName, masterFullName);
  return {
    decision: check.verdict === 'MATCH' ? 'PROCEED' : 'NEEDS_MANUAL',
    verdict: check.verdict,
    reason: check.reason,
    sharedWords: check.sharedWords,
  };
}

/** Convenience predicate for call sites that only need the boolean. */
export function namePasses(
  attioName: string | null | undefined,
  masterFullName: string | null | undefined,
): boolean {
  return nameGate(attioName, masterFullName).decision === 'PROCEED';
}
