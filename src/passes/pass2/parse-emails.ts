/**
 * Raw_Emails_JSON parsing.
 *
 * Two things below are real findings from a live Thread_Staging read
 * (2026-07-18, checking PASS 0/1's dry-run numbers), not guesses:
 *
 *   1. `recipient_email` was blank on every inbound sample message seen. The
 *      spec's resolution cascade ("primary = sender if inbound, principal
 *      recipient if outbound") relies on this field for outbound threads —
 *      worth watching on the first real dry run whether outbound threads have
 *      it populated more reliably than inbound ones did.
 *   2. `cc_list` is NOT a clean array or valid JSON — real values look like:
 *        "emailAddress: {'address': 'x@y.com', 'name': 'X Y'}\n\nemailAddress: {...}"
 *      Single-quoted, Python-dict-repr-style, multiple entries newline-joined.
 *      `parseCcList` extracts via regex rather than JSON.parse, and tries
 *      JSON.parse first as a defensive fallback in case some rows differ.
 */

import { OWNED_DOMAINS, OWNED_EMAILS } from '../../config/constants.js';
import type { RawEmailMessage } from './types.js';

const CC_ADDRESS_RE = /'address':\s*'([^']*)'/g;

/** Extract email addresses from the observed cc_list shape (see file header). */
export function parseCcList(raw: string): readonly string[] {
  const s = raw.trim();
  if (s === '') return [];

  // Defensive fallback: some rows might actually be valid JSON.
  try {
    const parsed: unknown = JSON.parse(s);
    if (Array.isArray(parsed)) {
      const emails = parsed
        .map((v) => (typeof v === 'string' ? v : (v as { address?: string; email?: string })?.address ?? (v as { email?: string })?.email))
        .filter((v): v is string => typeof v === 'string' && v !== '');
      if (emails.length > 0) return emails;
    }
  } catch {
    // fall through to regex extraction — this is the expected path for real data
  }

  const emails: string[] = [];
  let match: RegExpExecArray | null;
  CC_ADDRESS_RE.lastIndex = 0;
  while ((match = CC_ADDRESS_RE.exec(s)) !== null) {
    if (match[1]) emails.push(match[1]);
  }
  return emails;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse Raw_Emails_JSON into messages, deduped by email_msg_id (spec 2a).
 * Tolerant of a malformed/empty JSON string — returns [] rather than throwing,
 * since one bad thread shouldn't abort the whole working-set loop.
 */
export function parseRawEmailsJson(raw: string): readonly RawEmailMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: RawEmailMessage[] = [];

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    const emailMsgId = str(m['email_msg_id']);
    if (emailMsgId === '' || seen.has(emailMsgId)) continue;
    seen.add(emailMsgId);

    out.push({
      recordId: str(m['record_id']),
      emailMsgId,
      receivedAt: str(m['received_at']),
      sourceMailbox: str(m['source_mailbox']),
      direction: str(m['direction']),
      senderName: str(m['sender_name']),
      senderEmail: str(m['sender_email']).toLowerCase(),
      recipientName: str(m['recipient_name']),
      recipientEmail: str(m['recipient_email']).toLowerCase(),
      ccEmails: parseCcList(str(m['cc_list'])).map((e) => e.toLowerCase()),
      subject: str(m['subject']),
      body: str(m['body']),
      threadId: str(m['thread_id']),
    });
  }

  return out;
}

/** Spec preamble: owned/internal addresses are never the external contact. */
export function isOwnedAddress(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (e === '') return false;
  if ((OWNED_EMAILS as readonly string[]).includes(e)) return true;
  const domain = e.split('@')[1] ?? '';
  return (OWNED_DOMAINS as readonly string[]).includes(domain);
}

export function stripOwned(emails: readonly string[]): readonly string[] {
  return emails.filter((e) => !isOwnedAddress(e));
}
