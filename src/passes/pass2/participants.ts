/**
 * Spec 2b: "Identify primary (sender if inbound, principal recipient if
 * outbound) and secondaries." And 2a2: the test/placeholder guard.
 */

import { isOwnedAddress, stripOwned } from './parse-emails.js';
import type { RawEmailMessage } from './types.js';

export interface PrimarySecondary {
  readonly primaryEmail: string | null;
  readonly secondaryEmails: readonly string[];
}

/**
 * Fallback chain for "principal recipient" on an outbound thread, since real
 * data shows `recipient_email` is often blank (see parse-emails.ts's header
 * comment) — not spec'd, an inferred design choice:
 *   1. The most recent outbound message's recipient_email, if populated.
 *   2. That same message's first external cc_email.
 *   3. The most-frequently-appearing external email across the whole thread
 *      (any role) — a last-resort heuristic, not a confident signal.
 */
function principalRecipient(messages: readonly RawEmailMessage[]): string | null {
  const outbound = messages.filter((m) => m.direction === 'Outbound');
  const mostRecentOutbound = outbound[outbound.length - 1];

  if (mostRecentOutbound) {
    if (mostRecentOutbound.recipientEmail !== '' && !isOwnedAddress(mostRecentOutbound.recipientEmail)) {
      return mostRecentOutbound.recipientEmail;
    }
    const externalCc = stripOwned(mostRecentOutbound.ccEmails);
    if (externalCc.length > 0) return externalCc[0]!;
  }

  // Last resort: most frequent external address across all messages/roles.
  const counts = new Map<string, number>();
  for (const m of messages) {
    for (const e of stripOwned([m.senderEmail, m.recipientEmail, ...m.ccEmails])) {
      if (e === '') continue;
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [email, count] of counts) {
    if (count > bestCount) {
      best = email;
      bestCount = count;
    }
  }
  return best;
}

export function identifyPrimaryAndSecondary(
  messages: readonly RawEmailMessage[],
  threadDirection: string,
): PrimarySecondary {
  if (messages.length === 0) return { primaryEmail: null, secondaryEmails: [] };

  let primaryEmail: string | null;
  if (threadDirection === 'Outbound') {
    primaryEmail = principalRecipient(messages);
  } else {
    // Inbound (or anything else): sender of the most recent message.
    const last = messages[messages.length - 1]!;
    primaryEmail = !isOwnedAddress(last.senderEmail) && last.senderEmail !== '' ? last.senderEmail : null;
  }

  const allExternal = new Set<string>();
  for (const m of messages) {
    for (const e of stripOwned([m.senderEmail, m.recipientEmail, ...m.ccEmails])) {
      if (e !== '') allExternal.add(e);
    }
  }
  if (primaryEmail) allExternal.delete(primaryEmail);

  return { primaryEmail, secondaryEmails: [...allExternal] };
}

/**
 * Spec 2a2: "Lorem-ipsum or obvious test → NO_ACTION, tag noise:test."
 * Deliberately narrow — catches unambiguous placeholder content, not a
 * general spam/quality filter (that's triage's job, step c).
 */
const TEST_PATTERNS = [/lorem ipsum/i, /\btest test test\b/i, /\bthis is a test\b/i, /\basdf+\b/i];

export function isTestOrPlaceholder(messages: readonly RawEmailMessage[]): boolean {
  return messages.some((m) => TEST_PATTERNS.some((re) => re.test(m.body) || re.test(m.subject)));
}
