/**
 * Spec 2c: "Triage the content. NO_ACTION buckets: Sensitive (noise:sensitive),
 * Automated/transactional (noise:automated), Cold/spam (noise:cold),
 * Vendor/errand (vendor)."
 *
 * These are deterministic HEURISTICS, not a full-judgment classifier — the
 * spec gives category names but no detection rules for any of them. Genuinely
 * ambiguous or borderline content should fall through to the LLM enrichment
 * step (2's LLM calls, not built yet) rather than get force-classified here.
 * This module only catches clear, high-confidence cases; anything it doesn't
 * recognize returns isNoise: false, meaning "let the LLM step decide."
 */

import type { RawEmailMessage } from './types.js';
import type { TriageResult } from './types.js';

const AUTOMATED_SENDER_PATTERNS = [
  /^no-?reply@/i,
  /^do-?not-?reply@/i,
  /^notifications?@/i,
  /^alerts?@/i,
  /^automated@/i,
  /^system@/i,
];

const AUTOMATED_SUBJECT_PATTERNS = [
  /\breceipt\b/i,
  /\byour (order|invoice|payment)\b/i,
  /\bpassword reset\b/i,
  /\bverify your (email|account)\b/i,
  /\bunsubscribe\b/i,
  /\baccount statement\b/i,
];

const COLD_SUBJECT_PATTERNS = [
  /\bquick question\b/i,
  /\bpartnership opportunity\b/i,
  /\bgrow your (business|audience|list)\b/i,
  /\blimited time offer\b/i,
];

const VENDOR_SENDER_PATTERNS = [/support@/i, /billing@/i, /sales@/i, /orders?@/i];

const SENSITIVE_PATTERNS = [
  /\bmedical\b/i,
  /\bdiagnosis\b/i,
  /\bprescription\b/i,
  /\bssn\b/i,
  /\bsocial security\b/i,
];

function anyMessageMatches(messages: readonly RawEmailMessage[], patterns: readonly RegExp[], field: 'sender' | 'subject' | 'body'): boolean {
  return messages.some((m) => {
    const value = field === 'sender' ? m.senderEmail : field === 'subject' ? m.subject : m.body;
    return patterns.some((re) => re.test(value));
  });
}

export function triageContent(messages: readonly RawEmailMessage[]): TriageResult {
  if (messages.length === 0) {
    return { isNoise: false, tag: null, reason: 'no messages to triage' };
  }

  if (anyMessageMatches(messages, SENSITIVE_PATTERNS, 'body') || anyMessageMatches(messages, SENSITIVE_PATTERNS, 'subject')) {
    return { isNoise: true, tag: 'noise:sensitive', reason: 'medical/PII-adjacent keyword detected' };
  }

  if (anyMessageMatches(messages, AUTOMATED_SENDER_PATTERNS, 'sender') || anyMessageMatches(messages, AUTOMATED_SUBJECT_PATTERNS, 'subject')) {
    return { isNoise: true, tag: 'noise:automated', reason: 'automated/transactional sender or subject pattern' };
  }

  if (anyMessageMatches(messages, VENDOR_SENDER_PATTERNS, 'sender')) {
    return { isNoise: true, tag: 'vendor', reason: 'vendor/support-desk sender pattern' };
  }

  if (anyMessageMatches(messages, COLD_SUBJECT_PATTERNS, 'subject')) {
    return { isNoise: true, tag: 'noise:cold', reason: 'cold-outreach subject pattern' };
  }

  return { isNoise: false, tag: null, reason: 'no high-confidence noise pattern matched — defer to enrichment' };
}
