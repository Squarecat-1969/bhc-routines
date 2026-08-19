/**
 * The Reconciler family's name/field comparison helpers, ported verbatim from
 * BHC_Reconciler.md's "Name / field normalization helpers" block.
 *
 * SHARED ON PURPOSE. Reconciler Fix will need these exact functions when it is
 * built, and "exact" has to mean the same code, not a re-derivation that agrees
 * today and drifts later. The June 2026 incident (~82 records corrupted through
 * a stale pointer) is what a disagreement between two copies of a name gate
 * costs, so there is one copy.
 *
 * `sigWords` deliberately re-exports name-verify.ts's `significantWords` rather
 * than redefining the spec's `sig_words`: they are the same function — same
 * particle set, same lowercase-strip-punctuation-split — and this repo already
 * made the rule that the name gate exists once. Python's `\w` is unicode-aware,
 * so the spec's `[^\w\s]` keeps accented letters exactly as
 * `significantWords`'s `[\p{P}\p{S}]` does; "Assunção" survives in both.
 */

import { significantWords } from './name-verify.js';

/** Spec `sig_words` — significant words, particles removed. One definition, shared. */
export const sigWords = significantWords;

/**
 * Spec `norm` — normalized compare form: lowercase, punctuation to spaces,
 * whitespace collapsed, trimmed.
 */
export function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Spec `names_exact` — the STRICT gate: case-SENSITIVE, outer-trim only.
 * Deliberately not normalized: this is the "no review needed at all" test, and
 * loosening it silently converts real conflicts into clean passes.
 */
export function namesExact(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/** Spec `shares_word` — at least one significant word in common. */
export function sharesWord(a: string | null | undefined, b: string | null | undefined): boolean {
  const aw = sigWords(String(a ?? ''));
  const bw = sigWords(String(b ?? ''));
  for (const w of aw) if (bw.has(w)) return true;
  return false;
}

/** Spec `field_equal` — I1 field compare, normalized equality. */
export function fieldEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return norm(a) === norm(b);
}
