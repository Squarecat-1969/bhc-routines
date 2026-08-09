/**
 * Derive the scoring signals for one contact. Pure — no I/O, no clock, no
 * network.
 *
 * REWIRED 2026-08-08. The original model was built on message-level email
 * metadata: who sent each message, to whom, when, with what subject. That is
 * permanently unavailable to a workspace API token — Attio exposes no Emails
 * scope for tokens, only for OAuth apps authenticating as a member with a
 * connected mailbox. It is a product boundary, not a misconfiguration.
 *
 * What replaces it is Attio's own computed connection strength: the same
 * mailbox analysis, exposed as a result rather than as raw material. Better
 * coverage (97% of candidates vs. an endpoint that returns 403), no LLM cost.
 *
 * WHAT WAS LOST, PLAINLY — see docs/contacts-triage-notes.md #15:
 *   • Two-way vs one-way. Attio returns one blended number per person.
 *   • Personal reply vs colleague reply. The directionTwoWayTeam(28) /
 *     personal(35) split is gone, not refactored. It was the right model and
 *     there is no longer any input that could feed it.
 *   • Interaction counts, distinct-day counts, burst detection.
 *   • Recipient lists, and with them blast detection and the
 *     fewest-recipients provenance rule.
 *
 * WHAT SURVIVES:
 *   • Client-team domain coherence, computed from email_addresses across the
 *     candidate set — it never depended on message metadata. Weaker than
 *     before (its reply and span gates are gone), but intact in principle and
 *     still the thing that stops a large client team scoring as noise.
 *   • Span, now from first_interaction/last_interaction.
 *   • Auto-reply and transactional-subject detection, wherever a subject line
 *     is available — which is now only `last_interaction_subject`, 3% of
 *     candidates.
 */

import {
  CLIENT_TEAM_MIN_SAME_DOMAIN_PEOPLE,
  FREEMAIL_DOMAINS,
  GENERIC_ROLE_LOCAL_PARTS,
  TRANSACTIONAL_SUBJECT_PATTERNS,
} from '../../config/triage-constants.js';
import { diffDays } from '../../lib/dates.js';
import { domainOf, localPartOf } from './excludes.js';
import { pickProvenance } from './provenance.js';
import type { ContactSignals, LastDirection, UnbridgedContact } from './types.js';

const FREEMAIL = new Set<string>(FREEMAIL_DOMAINS as readonly string[]);
const GENERIC_LOCALS = new Set<string>(GENERIC_ROLE_LOCAL_PARTS as readonly string[]);

/**
 * Is the local part a human's mailbox, a generic company inbox, or noise?
 *
 * The obvious unattended addresses were already hard-excluded in STEP 2. What
 * this separates is the softer middle: `jane.doe@` (a person), `careers@` (a
 * real company mailbox that isn't a relationship), and `a7f39c2b8e@` (a
 * machine-minted address that isn't either).
 */
export function classifyLocalPart(email: string | null): ContactSignals['localPart'] {
  if (!email) return 'unknown';
  const local = localPartOf(email);
  if (local === '') return 'unknown';
  if (GENERIC_LOCALS.has(local)) return 'generic-role';

  if (/^[0-9a-f]{16,}$/.test(local)) return 'opaque';
  if (/^\d+$/.test(local)) return 'opaque';

  const stripped = local.replace(/\d+$/, '');
  const segments = stripped.split(/[._+-]/).filter((s) => s !== '');
  if (segments.length === 0 || segments.length > 3) return 'opaque';
  if (!segments.every((s) => /^[a-z]+$/.test(s))) return 'opaque';
  const alphaLength = segments.join('').length;
  if (alphaLength < 3 || alphaLength > 24) return 'opaque';

  return 'personal';
}

export function classifyDomain(email: string | null): ContactSignals['domainKind'] {
  if (!email) return 'unknown';
  const domain = domainOf(email);
  if (domain === '') return 'unknown';
  return FREEMAIL.has(domain) ? 'freemail' : 'company';
}

/**
 * Auto-replies are interactions, never replies.
 *
 * Retained after the rewire because it still governs the one subject line
 * that survives: an out-of-office must not become a contact's evidence line.
 * Re:/Fwd: wrappers are stripped first, which catches "Re: Automatic reply".
 */
export function isAutoReply(subject: string): boolean {
  let s = subject.trim().toLowerCase();
  for (;;) {
    const stripped = s.replace(/^(?:re|fw|fwd)\s*:\s*/, '');
    if (stripped === s) break;
    s = stripped;
  }
  return AUTO_REPLY_PREFIXES.some((prefix) => s.startsWith(prefix));
}

const AUTO_REPLY_PREFIXES = ['automatic reply', 'out of office', 'auto:'] as const;

export function isTransactionalSubject(subject: string): boolean {
  if (subject.trim() === '') return false;
  return TRANSACTIONAL_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

/**
 * CLIENT-TEAM COHERENCE — computed across the candidate set, which is why it
 * survived the loss of message metadata intact.
 *
 * Bobby runs agency projects with large client teams; every person on a
 * 10-recipient project thread is a legitimate contact worth minting. The
 * distinguishing feature is domain coherence: several people at one company
 * appearing together in the same unbridged population. Live example, confirmed
 * in this run: 13 candidates at dcsg.com.
 *
 * Freemail is excluded outright — "two people at gmail.com" is not a client
 * team, it is two unrelated individuals.
 *
 * WEAKER THAN BEFORE: the original also required a reply somewhere in the set
 * and a span of at least a day, both of which came from message metadata. What
 * is left is co-occurrence, which two unrelated contacts at a large vendor
 * (amazon.com, say) will also satisfy. The connection-strength weight is what
 * keeps those low; this signal alone cannot lift a Very weak contact into
 * keepers, which is checked by test.
 */
export function countByDomain(candidates: readonly UnbridgedContact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const contact of candidates) {
    if (!contact.primaryEmail) continue;
    const domain = domainOf(contact.primaryEmail);
    if (domain === '' || FREEMAIL.has(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

function normalizeDirection(raw: string | null): LastDirection {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'inbound':
      return 'inbound';
    case 'outbound':
      return 'outbound';
    case 'internal':
      return 'internal';
    default:
      return 'unknown';
  }
}

export interface DeriveSignalsInput {
  readonly contact: UnbridgedContact;
  /** Domain -> candidate count for this run, from `countByDomain`. */
  readonly domainCounts: ReadonlyMap<string, number>;
}

export function deriveSignals(input: DeriveSignalsInput): ContactSignals {
  const { contact, domainCounts } = input;

  const domain = contact.primaryEmail ? domainOf(contact.primaryEmail) : '';
  const isCompanyDomain = domain !== '' && !FREEMAIL.has(domain);
  const sameDomainCandidates = isCompanyDomain ? (domainCounts.get(domain) ?? 0) : 0;
  const clientTeam = sameDomainCandidates >= CLIENT_TEAM_MIN_SAME_DOMAIN_PEOPLE;

  const firstAt = contact.firstInteractionAt;
  const lastAt = contact.lastInteractionAt;
  const spanKnown = firstAt !== null && lastAt !== null;
  const spanDays = spanKnown ? Math.max(0, diffDays(lastAt, firstAt)) : 0;

  const subject = contact.lastInteractionSubject ?? '';
  const lastSubjectIsAutoReply = subject !== '' && isAutoReply(subject);

  return {
    strength: contact.strengthLabel,
    strengthLegacy: contact.strengthLegacy,
    strengthMissing: contact.strengthLabel === null,

    lastDirection: normalizeDirection(contact.lastInteractionDirection),
    lastChannel: contact.lastInteractionChannel,

    firstAt,
    lastAt,
    spanDays,
    spanKnown,

    hasName: (contact.name ?? '').trim() !== '',
    hasLinkedin: (contact.linkedin ?? '').trim() !== '',
    hasCompany: (contact.company ?? '').trim() !== '',
    hasReadableEvidence:
      (contact.lastInteractionSubject ?? '').trim() !== '' ||
      (contact.lastMeetingSummary ?? '').trim() !== '' ||
      (contact.description ?? '').trim() !== '',
    localPart: classifyLocalPart(contact.primaryEmail),
    domainKind: classifyDomain(contact.primaryEmail),

    clientTeam,
    clientTeamDomain: isCompanyDomain ? domain : null,
    sameDomainCandidates,

    // An auto-reply subject is never read as transactional evidence either —
    // it says nothing about the relationship in any direction.
    transactionalSubject: !lastSubjectIsAutoReply && isTransactionalSubject(subject),
    lastSubjectIsAutoReply,

    provenance: pickProvenance(contact),
  };
}
