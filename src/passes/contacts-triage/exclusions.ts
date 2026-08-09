/**
 * Contact_Exclusions — the tab that stops the queue refilling with contacts
 * already ruled on.
 *
 * This tab is load-bearing, and the failure it prevents is specific: delete
 * GameStop's record and the next order confirmation recreates it looking brand
 * new. Without a durable record of "already decided", every re-run re-presents
 * the same junk with a fresh face.
 *
 * Append-only from this routine. Rows with source `bobby` are written by Aida
 * when Bobby archives a contact, and are only ever read here.
 */

import { EXCLUSIONS_COLS, EXCLUSIONS_COLUMNS } from '../../config/triage-constants.js';
import type { CivilDate } from '../../lib/dates.js';
import { cell, type SheetRow } from '../../lib/sheets.js';
import type { Exclusion } from './types.js';

export function serializeExclusion(exclusion: Exclusion, excludedDate: CivilDate): unknown[] {
  const cells = new Array<unknown>(EXCLUSIONS_COLUMNS).fill('');
  cells[EXCLUSIONS_COLS.attioRecordId] = exclusion.attioRecordId;
  cells[EXCLUSIONS_COLS.name] = exclusion.name;
  cells[EXCLUSIONS_COLS.email] = exclusion.email;
  cells[EXCLUSIONS_COLS.reason] = exclusion.reason;
  cells[EXCLUSIONS_COLS.excludedDate] = excludedDate;
  cells[EXCLUSIONS_COLS.recoverable] = exclusion.recoverable ? 'TRUE' : 'FALSE';
  cells[EXCLUSIONS_COLS.source] = exclusion.source;
  return cells;
}

/**
 * Everything already ruled on, indexed for matching — by record id AND by
 * email address.
 *
 * The email index is what makes the MANUAL path actually work. Rows this
 * routine writes always carry an Attio record id, and rows Aida writes when
 * Bobby archives a contact do too. But a row Bobby adds by hand — the stated
 * answer for in-laws and differently-named relatives that surname matching
 * can't catch — is overwhelmingly likely to be a name and an email address,
 * not a UUID he'd have to go and look up. Matching on record id alone would
 * have silently ignored exactly the rows he cared most about.
 *
 * `unusableRows` counts rows carrying neither, which can never match anything
 * and are reported rather than passed over.
 */
export interface ExclusionIndex {
  readonly recordIds: ReadonlySet<string>;
  readonly emails: ReadonlySet<string>;
  readonly unusableRows: number;
}

export function readExclusionIndex(rows: readonly SheetRow[]): ExclusionIndex {
  const recordIds = new Set<string>();
  const emails = new Set<string>();
  let unusableRows = 0;

  for (const row of rows) {
    const id = cell(row, EXCLUSIONS_COLS.attioRecordId);
    const email = cell(row, EXCLUSIONS_COLS.email).toLowerCase();
    if (id === '' && email === '') {
      // A wholly blank row is padding, not a broken entry.
      if (row.some((v) => String(v ?? '').trim() !== '')) unusableRows += 1;
      continue;
    }
    if (id !== '') recordIds.add(id);
    if (email !== '' && email.includes('@')) emails.add(email);
  }

  return { recordIds, emails, unusableRows };
}

/** How a candidate matched the exclusions tab, or null if it didn't. */
export function matchExclusion(
  contact: { readonly attioRecordId: string; readonly primaryEmail: string | null; readonly allEmails: readonly string[] },
  index: ExclusionIndex,
): 'record-id' | 'email' | null {
  if (index.recordIds.has(contact.attioRecordId)) return 'record-id';
  const addresses = [contact.primaryEmail, ...contact.allEmails].filter((e): e is string => !!e);
  if (addresses.some((e) => index.emails.has(e.toLowerCase()))) return 'email';
  return null;
}

/** Counts per reason, for the STEP 7 report's historical context. */
export function countByReason(rows: readonly SheetRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (cell(row, EXCLUSIONS_COLS.attioRecordId) === '') continue;
    const reason = cell(row, EXCLUSIONS_COLS.reason) || '(no reason recorded)';
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}
