/**
 * Identity — address to BHC_ID, and the deliberately conservative subject match.
 *
 * ⚠ ATTIO IS THE PRIMARY DIRECTORY. Google `Contacts` is the LINKEDIN REACH
 * ENGINE: a contact enters it only when the originating interaction was on
 * LinkedIn. Every other channel lives in Attio. So calendar participants at
 * hmlglaw.com, xa.epicgames.com or gmail are Attio contacts BY DESIGN and will
 * essentially never be in `Contacts` — that is the two-CRM split working, not
 * a coverage gap.
 *
 * Measured 2026-09-01: `Contacts` holds ~400 rows, all LinkedIn-sourced, 132
 * with an email (~9%). Attio holds 2506 people. Ordering the cascade
 * Contacts-first would resolve almost nothing and would look like a broken
 * matcher rather than a directory pointed at the wrong CRM.
 *
 * `Contacts` is KEPT as a secondary lookup, not deleted: a LinkedIn contact
 * with an email who later took a meeting is real, just rare.
 *
 * ⚠ RESOLUTION IS ONE HOP, NOT TWO. An Attio person record carries
 * `bhc_contact_id` directly — verified live. Master_ID is consulted ONLY when
 * that field is absent, which is itself worth counting: Non-negotiable #15
 * says every Attio person should carry one before leaving PASS 1, and 251 of
 * 2506 (10.0%) do not.
 *
 * ⚠ AN UNMATCHED PARTICIPANT PRODUCES NO VERDICT. Never mint a contact; that
 * is Aida's job, human-confirmed, per the standing contract. Silence here is
 * correct behaviour, not a gap to close with a fuzzier matcher.
 */

import { textOf, type AttioClient } from '../../lib/attio.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import { RANGES } from '../../config/constants.js';
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

/** Which directory produced a BHC_ID — reported per run, never merged into one number. */
export type ResolutionPath = 'attio' | 'attio_via_masterid' | 'contacts' | 'unresolved';

export interface AddressResolution {
  readonly bhcId: string;
  readonly path: ResolutionPath;
}

export interface ResolverDeps {
  readonly attio: AttioClient;
  readonly sheets: SheetsClient;
  readonly contacts: ContactDirectory;
  readonly logger: { info(m: string): void; warn(m: string): void };
}

export interface ResolutionOutcome {
  readonly byAddress: ReadonlyMap<string, AddressResolution>;
  readonly counts: Readonly<Record<ResolutionPath, number>>;
  /** Attio records found by email but carrying NO bhc_contact_id — an NN#15 violation. */
  readonly attioMissingBhcId: readonly string[];
  readonly displayName: ReadonlyMap<string, string>;
}

/** Master_ID col E (Attio record_id) -> col A (BHC_ID). The fallback, not the path. */
async function loadAttioToBhc(sheets: SheetsClient): Promise<Map<string, string>> {
  const rows = await sheets.read(RANGES.masterId);
  const m = new Map<string, string>();
  for (const r of rows) {
    const bhcId = cell(r, 0);
    const recId = cell(r, 4);
    if (bhcId !== '' && recId !== '' && !m.has(recId)) m.set(recId, bhcId);
  }
  return m;
}

/**
 * Resolve a set of addresses to BHC_IDs, Attio first.
 *
 * One Attio query per DISTINCT address — the caller must dedupe across events,
 * which `resolveAllAddresses` does. Master_ID is read once, lazily, and only if
 * some Attio record turns out to lack `bhc_contact_id`.
 */
export async function resolveAllAddresses(
  addresses: readonly string[],
  deps: ResolverDeps,
): Promise<ResolutionOutcome> {
  const distinct = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))];
  const byAddress = new Map<string, AddressResolution>();
  const displayName = new Map<string, string>();
  const attioMissingBhcId: string[] = [];
  const counts: Record<ResolutionPath, number> = { attio: 0, attio_via_masterid: 0, contacts: 0, unresolved: 0 };
  let attioToBhc: Map<string, string> | null = null;

  for (const addr of distinct) {
    // ── 1. Attio, the primary directory ─────────────────────────────────
    let record;
    try {
      const hits = await deps.attio.searchPeopleByEmail(addr);
      record = hits[0];
    } catch (e) {
      deps.logger.warn(`  Attio lookup failed for an address: ${String(e).slice(0, 120)}`);
    }

    if (record) {
      const direct = textOf(record.values, 'bhc_contact_id') ?? '';
      const name = textOf(record.values, 'name') ?? '';
      if (direct !== '') {
        byAddress.set(addr, { bhcId: direct, path: 'attio' });
        counts.attio += 1;
        if (name !== '') displayName.set(direct, name);
        continue;
      }
      // ── 2. Master_ID by Attio record_id — the fallback, and a finding ──
      attioMissingBhcId.push(record.recordId);
      attioToBhc ??= await loadAttioToBhc(deps.sheets);
      const viaMaster = attioToBhc.get(record.recordId) ?? '';
      if (viaMaster !== '') {
        byAddress.set(addr, { bhcId: viaMaster, path: 'attio_via_masterid' });
        counts.attio_via_masterid += 1;
        if (name !== '') displayName.set(viaMaster, name);
        continue;
      }
    }

    // ── 3. Google Contacts — the LinkedIn edge case ─────────────────────
    const fromContacts = deps.contacts.byEmail.get(addr);
    if (fromContacts) {
      byAddress.set(addr, { bhcId: fromContacts, path: 'contacts' });
      counts.contacts += 1;
      continue;
    }

    byAddress.set(addr, { bhcId: '', path: 'unresolved' });
    counts.unresolved += 1;
  }

  return { byAddress, counts, attioMissingBhcId, displayName };
}
