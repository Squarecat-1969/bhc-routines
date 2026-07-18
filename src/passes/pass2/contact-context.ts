/**
 * Assembles the ContactContext the enrichment prompt uses (spec: "read the
 * contact's Personal_Notes (col AI), Topics_of_Interest (col AU), and
 * Conversation_Trigger (col AV) from the Contacts tab, and personal_notes,
 * topics_of_interest, and conversation_trigger from Attio"). Pure assembly —
 * every input is already-fetched data, no new Sheets/Attio calls here.
 */

import { PERSON_SLUGS } from '../../config/constants.js';
import { textOf } from '../../lib/attio.js';
import type { ContactContext } from './prompt.js';
import type { ContactsEmailMap } from './contacts-email-map.js';
import type { ResolvedContact } from './types.js';

export function buildContactContext(
  resolved: ResolvedContact,
  contactName: string,
  contactsMap: ContactsEmailMap,
  attioRecordValues: Record<string, unknown> | null,
): ContactContext | null {
  if (!resolved.bhcId) return null; // no known identity — nothing to look up

  const google = resolved.googleRow !== null ? contactsMap.personalContextByGoogleRow.get(resolved.googleRow) : undefined;

  const attioPersonalNotes = attioRecordValues ? (textOf(attioRecordValues, PERSON_SLUGS.personalNotes) ?? '') : '';
  const attioTopicsOfInterest = attioRecordValues ? (textOf(attioRecordValues, PERSON_SLUGS.topicsOfInterest) ?? '') : '';
  const attioConversationTrigger = attioRecordValues ? (textOf(attioRecordValues, PERSON_SLUGS.conversationTrigger) ?? '') : '';

  return {
    contactName,
    personalNotes: google?.personalNotes ?? '',
    topicsOfInterest: google?.topicsOfInterest ?? '',
    conversationTrigger: google?.conversationTrigger ?? '',
    attioPersonalNotes,
    attioTopicsOfInterest,
    attioConversationTrigger,
  };
}
