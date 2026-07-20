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

/**
 * Strips combining diacritical marks (accents, umlauts, etc.) via Unicode NFD
 * decomposition. "Emídio" -> "Emidio", "Håkon" -> "Hakon". Deliberately does
 * NOT touch true base-letter differences (ø, ß, ñ-as-distinct-letter in some
 * languages) — NFD only decomposes marks that Unicode considers combining
 * accents on an otherwise-shared base letter, so a genuine spelling
 * difference never gets miscounted as "diacritic only."
 */
export function stripDiacritics(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * True only when two names differ SOLELY in diacritical marks — same base
 * letters, same casing, same word count and order, once accents are removed.
 *
 * This is the gate for the July 2026 root-cause finding (roadmap: "Name
 * Conflicts backlog fully resolved") — 7 of the 11 ATTIO-only conflicts in
 * that batch were exactly this pattern (a March 14 bulk-import mismatch
 * between Master_ID's and Attio's original name sources), and it's expected
 * to keep recurring at low volume as Attio's own third-party enrichment
 * (LinkedIn/FullContact) continues touching more of the ~2,200 ATTIO-only
 * records over time. This function exists to auto-flag that low-risk subset
 * so it doesn't have to eat manual review time every time it resurfaces.
 *
 * Deliberately narrow, by design, not by oversight:
 *   - "Bo geddes" vs "Bo Geddes" does NOT qualify — capitalization is a
 *     different kind of difference than a missing accent, and conflating
 *     them would widen the auto-apply surface past what the evidence
 *     supports. (It stays in the manual-review path, same as today.)
 *   - "Carolina Valdovinos" vs "Carolina Valdovinos - AllSTEM" does NOT
 *     qualify — the stripped forms aren't equal (extra words), so an
 *     enrichment artifact correctly falls through to manual review rather
 *     than being auto-applied.
 *   - Identical strings return false — there is no "variant" of a string and
 *     itself, and in practice this case never reaches this function anyway
 *     (classifyNameDrift already resolves exact matches to EXACT upstream).
 */
export function isDiacriticOnlyVariant(a: string, b: string): boolean {
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (aTrim === '' || bTrim === '') return false;
  if (aTrim === bTrim) return false;
  return stripDiacritics(aTrim) === stripDiacritics(bTrim);
}
