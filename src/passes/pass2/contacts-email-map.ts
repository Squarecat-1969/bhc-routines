/**
 * Spec 2b Contacts schema note: "Read the full range A3:DI once at the start
 * of PASS 2. Build the email→BHC_ID map from cols A + F." Resolved by header
 * title, not hardcoded letters, same discipline as every other Contacts read
 * in this codebase (see pass4/load.ts, pass4_5/contacts.ts).
 */

import { CONTACTS_EMAIL_HEADER, RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import { silentLogger, type Logger } from '../../lib/logger.js';
import { columnLetter } from '../pass4/load.js';

export interface ContactsEmailEntry {
  readonly bhcId: string;
  readonly googleRow: number;
}

export interface ContactsEmailMap {
  readonly byEmail: ReadonlyMap<string, ContactsEmailEntry>;
  /** Contacts col A (Contact_ID/BHC_ID) value at each physical row — for the drift check. */
  readonly contactIdByGoogleRow: ReadonlyMap<number, string>;
}

const CONTACTS_ID_HEADER_CANDIDATES = ['Contact_ID', 'BHC_ID'] as const;
const CONTACTS_DATA_FIRST_ROW = 3;

export async function loadContactsEmailMap(
  sheets: SheetsClient,
  logger: Logger = silentLogger,
): Promise<ContactsEmailMap> {
  const headerRows = await sheets.read(RANGES.contactsHeader, 'FORMATTED_VALUE');
  const header = headerRows[0];
  if (!header) {
    throw new Error(`Contacts header row is empty (${RANGES.contactsHeader}) — cannot resolve columns.`);
  }
  const titles = header.map((h) => String(h ?? '').trim());

  function resolve(candidates: readonly string[]): number {
    for (const candidate of candidates) {
      const idx = titles.findIndex((t) => t.toLowerCase() === candidate.toLowerCase());
      if (idx !== -1) return idx;
    }
    throw new Error(
      `No column in ${RANGES.contactsHeader} matching ${candidates.join(' or ')}; ` +
        `found: ${titles.filter((t) => t !== '').join(', ') || '(all blank)'}`,
    );
  }

  const idCol = resolve(CONTACTS_ID_HEADER_CANDIDATES);
  const emailCol = resolve([CONTACTS_EMAIL_HEADER]);
  logger.info(
    `  Contacts email map columns: ID=${columnLetter(idCol)}[${idCol}] · Email=${columnLetter(emailCol)}[${emailCol}]`,
  );

  const rows = await sheets.read(RANGES.contactsData, 'FORMATTED_VALUE');
  const byEmail = new Map<string, ContactsEmailEntry>();
  const contactIdByGoogleRow = new Map<number, string>();

  rows.forEach((row, i) => {
    const googleRow = CONTACTS_DATA_FIRST_ROW + i;
    const bhcId = cell(row, idCol);
    const email = cell(row, emailCol).toLowerCase();
    if (bhcId !== '') contactIdByGoogleRow.set(googleRow, bhcId);
    if (bhcId === '' || email === '') return;
    // First match wins on a duplicate email — don't overwrite a real contact
    // with a later coincidental duplicate.
    if (!byEmail.has(email)) {
      byEmail.set(email, { bhcId, googleRow });
    }
  });

  logger.info(`  ${byEmail.size} email(s) mapped from ${rows.length} Contacts row(s)`);
  return { byEmail, contactIdByGoogleRow };
}
