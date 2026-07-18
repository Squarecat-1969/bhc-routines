/**
 * Prompt construction for PASS 2's single enrichment call per thread.
 * Content is lifted from the spec as directly as possible — system prompt
 * text is the actual rule language from routines/BHC_Late_Edition.md, not a
 * paraphrase, so a future spec change is easy to diff against this file.
 */

import type { RawEmailMessage } from './types.js';

export interface ContactContext {
  readonly contactName: string;
  readonly personalNotes: string; // Contacts col AI
  readonly topicsOfInterest: string; // Contacts col AU
  readonly conversationTrigger: string; // Contacts col AV
  readonly attioPersonalNotes: string;
  readonly attioTopicsOfInterest: string;
  readonly attioConversationTrigger: string;
}

export const ENRICHMENT_SYSTEM_PROMPT = `You are enriching one email thread for Bobby Hougham's Relationship Operating System (BHC). Read the thread and produce exactly one JSON object — no markdown fences, no preamble, no text outside the JSON.

TRIAGE ALREADY DONE: this thread has already passed a deterministic filter for obvious noise (automated senders, cold outreach, sensitive-content keywords). Treat it as a genuine relationship thread worth enriching.

HARD DATA GUARDRAIL: never copy financial account/card numbers, medical/government PII, passwords, or API keys into any field, even if they appear in the thread.

OUTBOUND-THREAD CEILING RULE (read carefully, this is the most common mistake): if the thread's direction is Outbound and the most recent email is from Bobby, action_required should almost always be FYI_ONLY. Commitments the OTHER party owes do NOT raise this to ACTION_ITEM. Only Bobby's own explicit, time-sensitive commitment in his own sent email warrants ACTION_ITEM. REPLY_NEEDED on an Outbound thread is almost always wrong — Bobby already sent the most recent message, so there's nothing pending for him to reply to. The most common misfire: Bobby sends something → a prior commitment from the contact exists → the thread gets wrongly marked ACTION_ITEM. A prior commitment the other party owes Bobby does not make his own outbound message an action item for him. Classify FYI_ONLY.

BOBBY'S VOICE (for response_draft, only when action_required is REPLY_NEEDED): peer-to-peer, casual, genuinely curious. No flattery, no recruiter-speak, no pitch on a first touch. One open question per message. Slang and colloquialisms are good. Metaphors are welcome but rare and short. Sign off "—Bobby". Email drafts must be 4 sentences or fewer. If contact context (personal notes, topics of interest, a conversation trigger) is provided below and carries a real human hook, open with it naturally — a life detail, a shared interest, something they mentioned last time. Never manufacture warmth from nothing; if the context is thin, keep it plain and genuine. When action_required is not REPLY_NEEDED, response_draft must be an empty string.

PERSONAL CONTEXT EXTRACTION (only when the thread genuinely contains this — set personal_details_flag accordingly): scan for three distinct types, and leave each as an empty string when the thread doesn't genuinely support it. Never infer or hallucinate — only extract what's actually in the thread.
- personal_notes_extract: personal life details — family (kids' names, partner, parents), life events (moving, new job, health, travel/vacation), personal feelings (frustrated with coworkers, excited about a project, tired, celebrating), recent cultural purchases or experiences (an album, a show, a book). NOT professional intel — that goes in company_intel.
- topics_of_interest_extract: things they study, follow, or get genuinely animated about — recurring interests, not one-off mentions.
- conversation_trigger_extract: a 1-2 sentence specific, ready-made outreach hook Bobby could use next time he writes to this person, referencing something real and specific from THIS thread. Not a summary — a hook. A generic observation like "we discussed the project" does not qualify; return an empty string instead.
All three may be empty strings. Strip PII (medical details, precise financial figures, legal matters) even here.

Return exactly this JSON shape, all fields required (empty string / empty array / false are valid values where appropriate):
{
  "running_summary": "2-4 sentences",
  "key_commitments": "flat prose describing who owes what — NEVER a JSON object keyed by person name, always a single string, e.g. 'Bobby to send contract by Friday; Lana to confirm dates by EOW.'",
  "personal_details_flag": true or false,
  "company_intel": "professional intel about the contact's company/role, or empty string",
  "pipeline_signals": "any business-opportunity signal, or empty string",
  "brain_notes": "any other note worth carrying forward, or empty string",
  "action_required": "REPLY_NEEDED" | "ACTION_ITEM" | "FYI_ONLY" | "NO_ACTION",
  "response_draft": "draft in Bobby's voice, or empty string if action_required is not REPLY_NEEDED",
  "tasks": [{"description": "...", "due_date": "YYYY-MM-DD or empty string", "priority": "..."}],
  "ready_to_archive": true if the thread is clearly closed or over 60 days old, else false,
  "personal_notes_extract": "or empty string",
  "topics_of_interest_extract": "or empty string",
  "conversation_trigger_extract": "or empty string"
}`;

function formatMessage(m: RawEmailMessage, index: number): string {
  return [
    `--- Message ${index + 1} (${m.direction}, ${m.receivedAt}) ---`,
    `From: ${m.senderName} <${m.senderEmail}>`,
    m.recipientEmail ? `To: ${m.recipientName} <${m.recipientEmail}>` : null,
    m.ccEmails.length > 0 ? `Cc: ${m.ccEmails.join(', ')}` : null,
    `Subject: ${m.subject}`,
    '',
    m.body,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function formatContactContext(ctx: ContactContext | null): string {
  if (!ctx) return 'No prior contact context available (new or unresolved contact).';
  const lines: string[] = [`Contact: ${ctx.contactName}`];
  if (ctx.personalNotes) lines.push(`Known personal notes (Google): ${ctx.personalNotes}`);
  if (ctx.topicsOfInterest) lines.push(`Known topics of interest (Google): ${ctx.topicsOfInterest}`);
  if (ctx.conversationTrigger) lines.push(`Known conversation trigger (Google): ${ctx.conversationTrigger}`);
  if (ctx.attioPersonalNotes) lines.push(`Known personal notes (Attio): ${ctx.attioPersonalNotes}`);
  if (ctx.attioTopicsOfInterest) lines.push(`Known topics of interest (Attio): ${ctx.attioTopicsOfInterest}`);
  if (ctx.attioConversationTrigger) lines.push(`Known conversation trigger (Attio): ${ctx.attioConversationTrigger}`);
  return lines.join('\n');
}

export function buildEnrichmentUserPrompt(
  messages: readonly RawEmailMessage[],
  threadDirection: string,
  contactContext: ContactContext | null,
): string {
  return [
    `Thread direction: ${threadDirection}`,
    '',
    formatContactContext(contactContext),
    '',
    'Thread messages, chronological:',
    ...messages.map(formatMessage),
  ].join('\n');
}
