/**
 * "Sensitive data never written. If seen in Write_Targets or
 * personal_context: skip and flag." — a non-negotiable from the spec's own
 * list that write-row.ts never implemented at all until now (found while
 * building confirm.ts, not part of the original build). Matches the
 * project's own broader §6 hard contract: "Financial account/card numbers,
 * medical/government PII, passwords, credentials — never copied into any
 * field... Summarize the substance, strip the secret."
 *
 * This is a heuristic safety net, not a perfect classifier — stated
 * plainly, not implied. Pattern-matching free text for secrets can't catch
 * everything (a sensitive detail phrased in prose with no distinctive
 * format is invisible to regex), and can occasionally false-positive on
 * ordinary content that happens to look like a credential pattern. The
 * asymmetry is deliberate: a false positive costs a blank field and a
 * flag Bobby can review; a false negative could write a real secret
 * permanently into Activity_Log/Contact_History/Attio. Erring toward
 * over-flagging is the correct trade here, not a flaw to tune away.
 *
 * Scope: only the genuinely free-text fields that carry LLM-summarized
 * email content need scanning. Fields typed as restricted enums (Channel/
 * Direction/Outcome — see write-targets.ts's ChannelValue/DirectionValue/
 * OutcomeValue) are structurally incapable of carrying arbitrary text and
 * are never scanned; scanning them would just be wasted work with zero
 * chance of ever matching.
 */

export type SensitiveCategory = 'credit_card' | 'ssn' | 'credential' | 'bank_account';

export interface SensitiveDataMatch {
  readonly category: SensitiveCategory;
}

// Standard Luhn checksum — meaningfully cuts false positives on generic
// long digit sequences (phone numbers without separators, tracking/
// reference numbers, large IDs) versus a bare digit-count regex alone.
// Not a perfect filter (real card numbers aren't uniformly random, so this
// doesn't guarantee zero false positives or zero false negatives), but a
// standard, well-understood heuristic improvement over nothing.
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const CREDENTIAL_RE = /\b(?:password|pwd|passcode|api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token)\s*[:=]\s*\S+/i;
const BANK_ROUTING_RE = /\brouting\s*(?:number|no\.?|#)?\s*[:=]?\s*\d{9}\b/i;
const BANK_ACCOUNT_RE = /\baccount\s*(?:number|no\.?|#)?\s*[:=]?\s*\d{6,17}\b/i;

/**
 * Scans one piece of text. Returns the first category found, or null if
 * clean. Deliberately returns only a category label, never the matched
 * substring itself — the whole point is to keep the secret out of
 * anything written or logged, including the flag describing the fact
 * that something was caught.
 */
export function detectSensitiveData(text: string): SensitiveDataMatch | null {
  if (!text) return null;

  if (SSN_RE.test(text)) return { category: 'ssn' };
  if (CREDENTIAL_RE.test(text)) return { category: 'credential' };
  if (BANK_ROUTING_RE.test(text) || BANK_ACCOUNT_RE.test(text)) return { category: 'bank_account' };

  const cardCandidates = text.match(CARD_CANDIDATE_RE) ?? [];
  for (const candidate of cardCandidates) {
    const digitsOnly = candidate.replace(/[ -]/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && luhnValid(digitsOnly)) {
      return { category: 'credit_card' };
    }
  }

  return null;
}

/**
 * The write-site helper — checks `text`, and if sensitive, returns an
 * empty string to actually write (never the original) plus a warning
 * naming the field and category (never the matched value). Otherwise
 * returns `text` unchanged and no warning. Callers push the warning
 * themselves into their own warnings array — this function has no side
 * effects, matching the rest of this pass's style of pure-where-possible
 * helpers with writes/logging owned by the caller.
 */
export function sanitizeField(text: string, fieldLabel: string): { value: string; warning: string | null } {
  const match = detectSensitiveData(text);
  if (!match) return { value: text, warning: null };
  return {
    value: '',
    warning: `Sensitive data (${match.category}) detected in ${fieldLabel} — field skipped, not written. Review and correct the source content.`,
  };
}
