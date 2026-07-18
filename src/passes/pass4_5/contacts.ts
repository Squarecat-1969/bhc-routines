/**
 * Wide Contacts loader for PASS 4.5.
 *
 * PASS 4.5 needs three Contacts columns resolved by title (Relationship_Tier,
 * Primary_Email, Effective_Segment) — spec 4.5b. This is a separate loader from
 * PASS 4's `loadTierIndex` (which only needs the tier column) rather than a
 * shared one: duplication across passes is the repo's stated convention, and
 * keeping this loader keyed by Google_Row (not by scanning for a BHC_ID column
 * that Contacts doesn't reliably have) is the important part to get right.
 *
 * Hard Contract: "Google_Row is the only authority for which Contacts row to
 * touch. Never infer a row from a BHC_ID number." So this indexes by the
 * physical sheet row, not by matching a Contacts column to Master_ID's BHC_ID.
 */

import { CONTACTS_EMAIL_HEADER, CONTACTS_SEGMENT_HEADER, RANGES, TIER_HEADER_CANDIDATES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import { silentLogger, type Logger } from '../../lib/logger.js';
import { columnLetter } from '../pass4/load.js';
import { normalizeTier } from '../pass4/cadence.js';
import type { Tier } from '../../config/constants.js';

export interface ContactsWideRow {
  readonly tier: Tier | null;
  readonly primaryEmail: string | null;
  readonly effectiveSegment: string | null;
}

export interface ContactsWideIndex {
  /** Keyed by the physical 1-based Contacts sheet row (Master_ID's Google_Row). */
  readonly byGoogleRow: ReadonlyMap<number, ContactsWideRow>;
  readonly tierHeaderTitle: string;
  readonly emailHeaderTitle: string;
  readonly segmentHeaderTitle: string;
}

/** First row of `RANGES.contactsData` — data starts at row 3 (row 2 is the ARRAYFORMULA spill). */
const CONTACTS_DATA_FIRST_ROW = 3;

export async function loadContactsWide(
  sheets: SheetsClient,
  logger: Logger = silentLogger,
): Promise<ContactsWideIndex> {
  const headerRows = await sheets.read(RANGES.contactsHeader, 'FORMATTED_VALUE');
  const header = headerRows[0];
  if (!header) {
    throw new Error(`Contacts header row is empty (${RANGES.contactsHeader}) — cannot resolve columns.`);
  }
  const titles = header.map((h) => String(h ?? '').trim());

  function resolve(candidates: readonly string[]): { title: string; index: number } {
    for (const candidate of candidates) {
      const idx = titles.findIndex((t) => t.toLowerCase() === candidate.toLowerCase());
      if (idx !== -1) return { title: titles[idx] ?? candidate, index: idx };
    }
    throw new Error(
      `No column in ${RANGES.contactsHeader} matching ${candidates.join(' or ')}; ` +
        `found: ${titles.filter((t) => t !== '').join(', ') || '(all blank)'}`,
    );
  }

  const tierCol = resolve(TIER_HEADER_CANDIDATES);
  const emailCol = resolve([CONTACTS_EMAIL_HEADER]);
  const segmentCol = resolve([CONTACTS_SEGMENT_HEADER]);

  logger.info(
    `  Contacts columns resolved: Tier="${tierCol.title}" ${columnLetter(tierCol.index)}[${tierCol.index}] · ` +
      `Email="${emailCol.title}" ${columnLetter(emailCol.index)}[${emailCol.index}] · ` +
      `Segment="${segmentCol.title}" ${columnLetter(segmentCol.index)}[${segmentCol.index}]`,
  );

  const rows = await sheets.read(RANGES.contactsData, 'FORMATTED_VALUE');
  const byGoogleRow = new Map<number, ContactsWideRow>();

  rows.forEach((row, i) => {
    const googleRow = CONTACTS_DATA_FIRST_ROW + i;
    const tierRaw = cell(row, tierCol.index);
    const emailRaw = cell(row, emailCol.index);
    const segmentRaw = cell(row, segmentCol.index);

    // Skip fully-blank rows rather than storing empty entries for every gap.
    if (tierRaw === '' && emailRaw === '' && segmentRaw === '') return;

    byGoogleRow.set(googleRow, {
      tier: tierRaw === '' ? null : normalizeTier(tierRaw),
      primaryEmail: emailRaw === '' ? null : emailRaw,
      effectiveSegment: segmentRaw === '' ? null : segmentRaw,
    });
  });

  return {
    byGoogleRow,
    tierHeaderTitle: tierCol.title,
    emailHeaderTitle: emailCol.title,
    segmentHeaderTitle: segmentCol.title,
  };
}
