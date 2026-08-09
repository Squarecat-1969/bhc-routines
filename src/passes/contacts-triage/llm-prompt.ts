/**
 * Prompt construction for the STEP 4 call.
 *
 * Criteria-based language and a structured response, deliberately. Late
 * Edition's self-refusal failures came from broad prompting with
 * persuasion-flavoured copy; nothing here asks the model to adopt a persona,
 * asserts that a task is authorized, or argues for an answer. It states what
 * the evidence is, states the criteria, and asks one question.
 *
 * What the model gets is what deterministic scoring cannot read — free text
 * on the record — plus the deterministic score and its signals AS CONTEXT.
 *
 * THAT EVIDENCE IS NOW THIN. Per-message subjects and AI summaries are
 * permanently unavailable to a workspace token, so what remains is
 * `last_interaction_subject` (3% of candidates) and `last_meeting_summary`
 * (4%). For most contacts this call will be reasoning about a name, a domain
 * and the deterministic signals — which is close to re-deriving what the score
 * already knows. Weigh that before spending calls; the band count in the STEP 7
 * report is the number to judge it on.
 */

import { SUMMARY_CHARS_IN_PROMPT } from '../../config/triage-constants.js';
import type { ContactSignals, DeterministicScore, UnbridgedContact } from './types.js';

export const TRIAGE_SYSTEM_PROMPT = `You classify one contact record for a business CRM triage queue. Return exactly one JSON object — no markdown fences, no preamble, no text outside the JSON.

THE QUESTION, and the only question: is this a professional relationship worth tracking in a business CRM, or is it transactional, vendor, or administrative noise?

WHOSE CRM THIS IS: Bobby Hougham, an agency principal. He runs business development, an executive job search, and ongoing relationship maintenance. Judge "worth tracking" against those three activities and nothing else.

CRITERIA FOR A HIGH SCORE (75-100) — a professional relationship:
- A named individual at a company, in a role that intersects Bobby's work: client-side marketing or brand staff, agency peers, hiring managers, recruiters for executive roles, founders, prospective partners, former colleagues.
- Evidence of an actual exchange: they replied, or the correspondence recurs over time, or several people from one company appear across multiple threads.
- Subjects that read like human working conversation — projects, scheduling, proposals, introductions, follow-ups.

CRITERIA FOR A LOW SCORE (0-25) — noise:
- Transactional: order confirmations, receipts, shipping, appointment reminders, subscription and billing notices.
- Vendor or service-provider admin that Bobby is a customer of rather than a peer with.
- Life admin. A mortgage broker, an insurance agent, a contractor, a school or medical office is NOT a keeper — that is personal logistics, and personal contacts live elsewhere.
- Marketing sends, newsletters, event blasts, unsolicited cold outreach from strangers.

MIDDLE SCORES (26-74) are for genuine ambiguity — some evidence of a professional connection, not enough to be confident either way. Use them. An honest 50 is more useful than a confident guess.

WEIGHING THE EVIDENCE:
- Any readable evidence (a subject line, an interaction summary, a description) is what you have that the deterministic score does not. Read it for what kind of relationship this is, not for volume.
- The deterministic score and its signals are given as context, and the connection strength within them is Attio's own analysis of the full mailbox — real evidence, not a guess. Where readable evidence clearly contradicts it, follow the evidence; where there is little or none, stay close to the score.
- A contact with almost no readable evidence is ambiguous, not junk. Score it in the middle and say the evidence was thin.
- Do not infer seniority, intent, or a relationship that the evidence does not show.

Return exactly this JSON shape and nothing else:
{"score": <integer 0-100>, "reason": "<one sentence naming the specific evidence you scored on>"}`;

function line(label: string, value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : `${label}: ${v}`;
}

function formatSignals(signals: ContactSignals, deterministic: DeterministicScore): string {
  const parts: string[] = [
    `deterministic score: ${deterministic.score}/100`,
    `Attio connection strength: ${signals.strength ?? 'not computed'}${
      signals.strengthLegacy !== null ? ` (${signals.strengthLegacy.toFixed(1)})` : ''
    }`,
    signals.spanKnown
      ? `interaction span: ${signals.spanDays} day(s), ${signals.firstAt} to ${signals.lastAt}`
      : 'interaction span: unknown (no interaction dates on the record)',
  ];
  if (signals.lastChannel) parts.push(`last interaction channel: ${signals.lastChannel}`);
  if (signals.lastDirection !== 'unknown') {
    parts.push(`most recent interaction was ${signals.lastDirection} (one interaction only, not a pattern)`);
  }
  if (signals.clientTeam) {
    parts.push(`${signals.sameDomainCandidates} untriaged contacts share @${signals.clientTeamDomain}`);
  }
  if (signals.transactionalSubject) parts.push('the last subject line matches a transactional pattern');
  parts.push(`signals: ${deterministic.contributions.map((x) => x.label).join(', ')}`);
  return parts.map((p) => `- ${p}`).join('\n');
}

export function buildTriageUserPrompt(
  contact: UnbridgedContact,
  signals: ContactSignals,
  deterministic: DeterministicScore,
): string {
  const identity = [
    line('Name', contact.name) ?? 'Name: (none on record)',
    line('Email', contact.primaryEmail),
    line('Company', contact.company),
    line('Role', contact.jobTitle),
    line('Description', contact.description),
  ].filter((l): l is string => l !== null);

  // What the model gets that the score cannot read is now free text on the
  // record, not a thread. Message-level subjects and per-email AI summaries
  // are permanently unavailable to a workspace token — see
  // docs/contacts-triage-notes.md #15 — so the readable evidence is whatever
  // Attio has already distilled onto the person.
  const evidence: string[] = [];
  if (contact.lastInteractionSubject) {
    evidence.push(`- Last interaction subject: ${contact.lastInteractionSubject.trim()}`);
  }
  if (contact.lastMeetingSummary) {
    evidence.push(`- Last interaction summary: ${contact.lastMeetingSummary.trim().slice(0, SUMMARY_CHARS_IN_PROMPT)}`);
  }

  return [
    'CONTACT',
    ...identity,
    '',
    'DETERMINISTIC ASSESSMENT (context — you may disagree with it)',
    formatSignals(signals, deterministic),
    '',
    'READABLE EVIDENCE',
    ...(evidence.length > 0 ? evidence : ['- (none on the record)']),
  ].join('\n');
}
