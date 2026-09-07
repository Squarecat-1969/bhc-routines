/**
 * Raw_Emails_JSON parsing.
 *
 * The three things below are real findings from live data, not guesses.
 * 1 and 2 come from a Thread_Staging read (2026-07-18, checking PASS 0/1's
 * dry-run numbers); 3 from a scan of all 394 Brain_Complete rows (2026-09-07):
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
 *
 *   3. `recipient_email` holds MULTIPLE comma-joined addresses on real
 *      outbound threads — e.g. "chris.martin@dcsg.com,rachel.norris@dcsg.com".
 *      Until 2026-09-07 it was read as one string, so PASS 2 handed
 *      identifyPrimaryAndSecondary a single "address" that could never match
 *      anything: Brain_Complete row 356 resolved to no contact at all even
 *      though Chris Martin has been bridged as BHC-00715 since 2026-04-13.
 *      The same string also defeated stripOwned on the SECONDARY path, because
 *      a joined string containing sevrin@thenewblank.com is not itself an
 *      owned address. See parseAddressList for the measured separator set.
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

/**
 * Split an address-list field into individual addresses.
 *
 * ⚠ THE SEPARATOR SET IS MEASURED, NOT IMAGINED. Scanned 2026-09-07 across all
 * 394 Brain_Complete rows / 516 messages:
 *
 *   sender_email     516 non-empty values, ZERO holding more than one address
 *   recipient_email  128 non-empty values, 54 holding two or more — and every
 *                    single one of those 54 is comma-joined
 *
 * No semicolons, no `Name <addr@x.com>` display-name forms, no pipes, no
 * newlines, no whitespace-joined pairs — in either field. Those shapes are
 * common in other mail clients and are the obvious things to defend against.
 * They are not in THIS data, and handling them would be untested code wearing
 * the appearance of a guarantee. ⚠ IF A SEMICOLON OR AN ANGLE BRACKET EVER
 * APPEARS HERE, this function and its test are the two places to change; the
 * splitter is deliberately narrow so that day is a visible edit, not a silent
 * near-miss.
 *
 * `sender_email` is left a scalar for the same reason: measured, never plural.
 */
export function parseAddressList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
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
      recipientEmails: parseAddressList(str(m['recipient_email'])),
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
