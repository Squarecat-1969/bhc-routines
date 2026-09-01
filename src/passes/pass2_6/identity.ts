/**
 * Identity — address to BHC_ID, and the deliberately conservative subject match.
 *
 * ⚠ AN UNMATCHED PARTICIPANT PRODUCES NO VERDICT. Never mint a contact; that
 * is Aida's job, human-confirmed, per the standing contract. Silence here is
 * correct behaviour, not a gap to close with a fuzzier matcher.
 */

import { buildContactsIndex } from '../reconciler/google.js';

export interface ContactDirectory {
  /** lower-cased primary email -> BHC_ID */
  readonly byEmail: ReadonlyMap<string, string>;
  /** normalised "first last" -> BHC_ID */
  readonly byName: ReadonlyMap<string, string>;
  /** BHC_ID -> display name, for the queue row */
  readonly displayName: ReadonlyMap<string, string>;
}

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildContactDirectory(
  contactsHeader: readonly (readonly unknown[])[],
  contactsData: readonly (readonly unknown[])[],
): ContactDirectory {
  const idx = buildContactsIndex(contactsHeader, contactsData);
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
  const displayName = new Map<string, string>();

  for (const [row, ident] of idx.identity) {
    const bhcId = idx.colA.get(row) ?? '';
    if (bhcId === '') continue;
    const email = (ident.primaryEmail ?? '').trim().toLowerCase();
    if (email !== '' && !byEmail.has(email)) byEmail.set(email, bhcId);

    const full = `${ident.firstName ?? ''} ${ident.lastName ?? ''}`.trim();
    const norm = normalizeName(full);
    // ⚠ A single-token name is not matchable conservatively — "Brian" would
    // hit any subject containing it. Require both parts.
    if (norm !== '' && norm.includes(' ') && !byName.has(norm)) byName.set(norm, bhcId);
    if (full !== '' && !displayName.has(bhcId)) displayName.set(bhcId, full);
  }
  return { byEmail, byName, displayName };
}

/** Addresses -> BHC_IDs. The strong path: an address is an identity, not a guess. */
export function resolveByAddress(addresses: readonly string[], dir: ContactDirectory): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    const id = dir.byEmail.get(a.trim().toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Subject -> BHC_IDs, CONSERVATIVELY.
 *
 * The inversion matters: this does not parse a name out of the subject, it
 * checks whether any KNOWN contact's full name appears in it as a whole
 * phrase. "Lunch w Brian Johnson" matches the contact Brian Johnson; it can
 * never invent a person, because every candidate comes from the directory.
 *
 * ⚠ Full name only, word-bounded. A first-name match would tie every "Lunch
 * with Brian" to one Brian, and §5 of the build brief requires exact or
 * near-exact, never a fuzzy guess.
 */
export function resolveBySubject(subject: string, dir: ContactDirectory): string[] {
  const hay = ` ${normalizeName(subject)} `;
  if (hay.trim() === '') return [];
  const out: string[] = [];
  for (const [name, bhcId] of dir.byName) {
    if (hay.includes(` ${name} `) && !out.includes(bhcId)) out.push(bhcId);
  }
  return out;
}
