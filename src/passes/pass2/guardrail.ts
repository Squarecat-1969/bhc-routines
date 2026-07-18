/**
 * Spec 2d, HARD DATA GUARDRAIL: "Never copy financial account/card numbers,
 * medical/government PII, passwords, API keys into any field."
 *
 * This is a pattern-based SAFETY NET, not a substitute for the LLM
 * enrichment step's own judgment (2's LLM calls, not built yet) — a human
 * writing "my SSN is 123-45-6789" gets caught by a regex; a paraphrase or an
 * indirect reference won't be. Two uses: (1) scan raw content and refuse to
 * proceed if a hard match is found in something about to be copied verbatim,
 * (2) redact before logging/reporting so even a report never echoes real
 * secrets.
 */

export type SensitiveCategory = 'CREDIT_CARD' | 'SSN' | 'API_KEY' | 'PASSWORD_LABEL';

export interface SensitiveMatch {
  readonly category: SensitiveCategory;
  /** The matched text, already redacted — never the raw sensitive value. */
  readonly redacted: string;
}

// Credit card: 13-19 digits, optionally grouped by spaces/dashes in 4s.
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
// US SSN: NNN-NN-NNNN, or explicit "SSN"/"social security" label near digits.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Common API key shapes: sk-..., long hex/base64-ish tokens after a labeled key= or token=.
const API_KEY_RE = /\b(?:sk|pk|api[_-]?key|token)[_-]?[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/gi;
// A password explicitly labeled as such, followed by a value.
const PASSWORD_LABEL_RE = /\bpassword\s*[:=]\s*\S+/gi;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactMiddle(s: string): string {
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)}`;
}

/** Scan free text for hard-guardrail patterns. Returns [] for clean text. */
export function findSensitiveMatches(text: string): readonly SensitiveMatch[] {
  const out: SensitiveMatch[] = [];

  for (const m of text.matchAll(CREDIT_CARD_RE)) {
    const digitsOnly = m[0].replace(/[ -]/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && luhnValid(digitsOnly)) {
      out.push({ category: 'CREDIT_CARD', redacted: redactMiddle(digitsOnly) });
    }
  }

  for (const m of text.matchAll(SSN_RE)) {
    out.push({ category: 'SSN', redacted: redactMiddle(m[0].replace(/-/g, '')) });
  }

  for (const m of text.matchAll(API_KEY_RE)) {
    out.push({ category: 'API_KEY', redacted: redactMiddle(m[0]) });
  }

  for (const m of text.matchAll(PASSWORD_LABEL_RE)) {
    out.push({ category: 'PASSWORD_LABEL', redacted: redactMiddle(m[0]) });
  }

  return out;
}

export function hasSensitiveData(text: string): boolean {
  return findSensitiveMatches(text).length > 0;
}

/** Replace every hard-guardrail match with a category-labeled placeholder — safe to log or write. */
export function redactSensitiveData(text: string): string {
  let out = text;
  out = out.replace(CREDIT_CARD_RE, (m) => (luhnValid(m.replace(/[ -]/g, '')) ? '[REDACTED_CARD]' : m));
  out = out.replace(SSN_RE, '[REDACTED_SSN]');
  out = out.replace(API_KEY_RE, '[REDACTED_API_KEY]');
  out = out.replace(PASSWORD_LABEL_RE, '[REDACTED_PASSWORD]');
  return out;
}
