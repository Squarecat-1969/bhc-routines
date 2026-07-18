/**
 * Spec 2b resolution cascade + drift check.
 *
 *   Contacts email map → BHC_ID + Google_Row
 *   Miss → Attio by email → record_id + bhc_contact_id
 *   Cross-reference Master_ID → Location, Attio_Record_ID, authoritative Google_Row
 *   Still no match → new-contact candidate (never fabricate a BHC_ID)
 *
 * DRIFT CHECK (per resolved contact after cascade):
 *   Google: confirm Contacts col A at Google_Row == BHC_ID from Master_ID.
 *   Attio: read bhc_contact_id attribute.
 *   Mismatch on either → tag, never abort, Write_Targets withheld for that contact.
 */

import type { AttioClient } from '../../lib/attio.js';
import { PERSON_SLUGS } from '../../config/constants.js';
import { textOf } from '../../lib/attio.js';
import type { MasterIdIndex } from '../pass4/load.js';
import type { ContactsEmailMap } from './contacts-email-map.js';
import type { DriftCheckResult, DriftTag, ResolvedContact } from './types.js';

export interface ResolveOptions {
  readonly contactsMap: ContactsEmailMap;
  readonly masterIndex: MasterIdIndex;
  readonly attio: AttioClient;
}

/**
 * Resolve one email through the full cascade. Never throws on a miss — an
 * unresolved email is a legitimate outcome (source = 'UNRESOLVED'), not an
 * error; a new-contact candidate is also legitimate (source = 'NEW_CANDIDATE')
 * and never fabricates a BHC_ID.
 */
export async function resolveContact(email: string, opts: ResolveOptions): Promise<ResolvedContact> {
  const e = email.trim().toLowerCase();

  // 1. Contacts email map.
  const contactsHit = opts.contactsMap.byEmail.get(e);
  if (contactsHit) {
    const master = opts.masterIndex.byBhcId.get(contactsHit.bhcId);
    return {
      email: e,
      source: 'CONTACTS',
      bhcId: contactsHit.bhcId,
      googleRow: contactsHit.googleRow,
      attioRecordId: master?.attioRecordId || null,
      location: master?.location ?? null,
    };
  }

  // 2. Miss → Attio by email.
  let attioMatches: Awaited<ReturnType<AttioClient['searchPeopleByEmail']>> = [];
  try {
    attioMatches = await opts.attio.searchPeopleByEmail(e);
  } catch {
    attioMatches = []; // treat a search failure as a miss, cascade continues
  }

  if (attioMatches.length === 1) {
    const record = attioMatches[0]!;
    const bhcContactId = textOf(record.values, PERSON_SLUGS.bhcContactId);
    if (bhcContactId) {
      // 3. Cross-reference Master_ID for the authoritative Google_Row/Location.
      const master = opts.masterIndex.byBhcId.get(bhcContactId);
      return {
        email: e,
        source: 'ATTIO',
        bhcId: bhcContactId,
        googleRow: master?.googleRow ?? null,
        attioRecordId: record.recordId,
        location: master?.location ?? null,
      };
    }
  }

  // 4. Still no match → new-contact candidate. Never fabricate a BHC_ID.
  if (attioMatches.length === 0) {
    return { email: e, source: 'NEW_CANDIDATE', bhcId: null, googleRow: null, attioRecordId: null, location: null };
  }

  // Ambiguous Attio match (>1) or a match with no bhc_contact_id — can't
  // confidently resolve, but it's not "no data found" either.
  return { email: e, source: 'UNRESOLVED', bhcId: null, googleRow: null, attioRecordId: null, location: null };
}

export interface DriftCheckInput {
  readonly resolved: ResolvedContact;
  /** Contacts col A value at resolved.googleRow, from the same wide read used for resolution. */
  readonly contactsColAAtGoogleRow: string | null;
  /** The Attio record already fetched during resolution, if any — avoids a second fetch. */
  readonly attioRecordValues: Record<string, unknown> | null;
}

export function checkDrift(input: DriftCheckInput): DriftCheckResult {
  const { resolved } = input;
  const tags: DriftTag[] = [];
  const notes: string[] = [];

  if (!resolved.bhcId) {
    return { clean: true, tags: [], notes: [] }; // nothing to drift-check for an unresolved/new contact
  }

  if (resolved.googleRow !== null && (resolved.location === 'GOOGLE' || resolved.location === 'BOTH')) {
    if (input.contactsColAAtGoogleRow !== resolved.bhcId) {
      tags.push('drift:google-row-mismatch');
      notes.push(
        `Contacts col A at row ${resolved.googleRow} is "${input.contactsColAAtGoogleRow ?? 'null'}", expected ${resolved.bhcId}`,
      );
    }
  }

  if (resolved.attioRecordId && (resolved.location === 'ATTIO' || resolved.location === 'BOTH')) {
    const attioBhcId = input.attioRecordValues ? textOf(input.attioRecordValues, PERSON_SLUGS.bhcContactId) : null;
    if (attioBhcId !== resolved.bhcId) {
      tags.push('drift:attio-id-mismatch');
      notes.push(`Attio record ${resolved.attioRecordId} bhc_contact_id is "${attioBhcId ?? 'null'}", expected ${resolved.bhcId}`);
    }
  }

  return { clean: tags.length === 0, tags, notes };
}
