/**
 * Name-verification gate.
 *
 * Semantics are lifted verbatim from BHC_Reconciler_Fix.md Step 1.5 — the gate
 * whose absence caused the June 2026 incident where ~82 contact records were
 * silently corrupted by writing through a stale pointer. Reused rather than
 * reinvented so every routine that writes to Attio agrees on what "the name
 * matches" means.
 *
 * Rule: normalize to lowercase, strip punctuation, require at least ONE
 * significant word in common. A missing name is NOT a pass — it is UNVERIFIABLE,
 * which withholds the write.
 */

/** Particles excluded from significance (Reconciler_Fix Step 1.5, PASS 4.5h). */
export const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'the',
  'of',
  'a',
  'an',
  'and',
  'de',
  'van',
  'von',
]);

export function significantWords(name: string): Set<string> {
  const cleaned = name
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !NAME_PARTICLES.has(w));
  return new Set(cleaned);
}

export type NameVerdict = 'MATCH' | 'MISMATCH' | 'UNVERIFIABLE';

export interface NameCheck {
  readonly verdict: NameVerdict;
  readonly sharedWords: readonly string[];
  readonly reason: string;
}

export function verifyName(
  attioName: string | null | undefined,
  masterName: string | null | undefined,
): NameCheck {
  const a = attioName?.trim() ?? '';
  const m = masterName?.trim() ?? '';

  if (a === '' || m === '') {
    return {
      verdict: 'UNVERIFIABLE',
      sharedWords: [],
      reason:
        a === '' && m === ''
          ? 'name unavailable for verification (missing on both Attio and Master_ID)'
          : a === ''
            ? 'name unavailable for verification (missing on Attio record)'
            : 'name unavailable for verification (missing in Master_ID)',
    };
  }

  const aw = significantWords(a);
  const mw = significantWords(m);
  if (aw.size === 0 || mw.size === 0) {
    return {
      verdict: 'UNVERIFIABLE',
      sharedWords: [],
      reason: 'name unavailable for verification (no significant words after normalization)',
    };
  }

  const shared = [...aw].filter((w) => mw.has(w));
  if (shared.length > 0) {
    return { verdict: 'MATCH', sharedWords: shared, reason: `shares ${shared.join(', ')}` };
  }

  return {
    verdict: 'MISMATCH',
    sharedWords: [],
    reason: `zero significant words in common between "${a}" and "${m}"`,
  };
}
