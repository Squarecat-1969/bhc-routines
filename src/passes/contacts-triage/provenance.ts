/**
 * The provenance line — the one piece of evidence shown on the card so Bobby
 * can tell who this person is without opening Attio.
 *
 * This is the thing that genuinely needed message metadata. The original rule
 * ("the most identifying email — fewest recipients wins") cannot be computed
 * at all any more, so it degrades through the person record's own readable
 * fields instead.
 *
 * THE RULE THAT MATTERS: if nothing readable exists, the line is BLANK. Not
 * "email contact", not a synthesized description, not the address restated as
 * prose. A blank evidence line is honest; an invented one teaches Bobby to
 * distrust every card in the queue, including the good ones.
 *
 * Which fallback was used is recorded on the row, so the card can show its own
 * confidence rather than presenting a job title with the same authority as a
 * real subject line.
 */

import { PROVENANCE_TEXT_CHARS } from '../../config/triage-constants.js';
import { isAutoReply } from './signals.js';
import type { Provenance, UnbridgedContact } from './types.js';

function clean(raw: string | null): string | null {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > PROVENANCE_TEXT_CHARS ? `${text.slice(0, PROVENANCE_TEXT_CHARS - 1)}…` : text;
}

/**
 * In order: the last interaction's subject line, Attio's last-meeting summary,
 * the record's description, then role and company. Blank if none exist.
 *
 * `last_interaction_subject` leads the chain — an actual email subject is the
 * closest surviving equivalent of the original rule, and it is what keeps the
 * auto-reply deprioritisation meaningful. An out-of-office subject is skipped
 * rather than used: it is nearly always the shortest, most recent thing on the
 * record, so without this it would routinely become a contact's whole
 * identity on the card. (Both of these go slightly beyond the fallback chain
 * as specified — flagged in docs/contacts-triage-notes.md #17.)
 */
export function pickProvenance(contact: UnbridgedContact): Provenance | null {
  const subject = clean(contact.lastInteractionSubject);
  if (subject !== null && !isAutoReply(subject)) {
    return { text: subject, date: contact.lastInteractionAt, source: 'last-interaction-subject' };
  }

  const summary = clean(contact.lastMeetingSummary);
  if (summary !== null) {
    return { text: summary, date: contact.lastInteractionAt, source: 'last-meeting-summary' };
  }

  const description = clean(contact.description);
  if (description !== null) {
    return { text: description, date: null, source: 'description' };
  }

  // Measured live: job_title is 0% populated and company_name 0%, but the
  // `company` record reference resolves for 81 of 102 candidates — so in
  // practice this rung renders as the company alone. Whatever exists is used;
  // nothing is filled in around it.
  const role = clean(contact.jobTitle);
  const company = clean(contact.company);
  if (role !== null && company !== null) {
    return { text: `${role} at ${company}`, date: null, source: 'role-and-company' };
  }
  if (role !== null) return { text: role, date: null, source: 'role-and-company' };
  if (company !== null) return { text: company, date: null, source: 'role-and-company' };

  return null;
}
