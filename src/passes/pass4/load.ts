/**
 * Sheets-side loaders for PASS 4: the Master_ID pointer table and the tier index.
 */

import { RANGES, TIER_HEADER_CANDIDATES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import { normalizeTier } from './cadence.js';
import type { Tier } from '../../config/constants.js';

export interface MasterIdEntry {
  readonly bhcId: string;
  readonly fullName: string;
  readonly location: string;
  readonly googleRow: number | null;
  readonly attioRecordId: string;
  /** 1-based sheet row this entry came from. */
  readonly masterRow: number;
}

export interface MasterIdIndex {
  readonly byBhcId: ReadonlyMap<string, MasterIdEntry>;
  readonly byAttioRecordId: ReadonlyMap<string, MasterIdEntry>;
  /** Attio record IDs appearing on more than one Master_ID row — never resolved. */
  readonly duplicateAttioRecordIds: readonly string[];
  readonly rowCount: number;
}

/**
 * Master_ID!A2:F → A BHC_ID · B Full_Name · C Location · D Google_Row · E Attio_Record_ID · F Notes
 *
 * Google_Row is parsed but never derived: Non-negotiable #2 makes Master_ID the
 * only row authority, so a blank stays null rather than being inferred.
 */
export async function loadMasterId(sheets: SheetsClient): Promise<MasterIdIndex> {
  const rows = await sheets.read(RANGES.masterId);

  const byBhcId = new Map<string, MasterIdEntry>();
  const byAttioRecordId = new Map<string, MasterIdEntry>();
  const duplicates = new Set<string>();

  rows.forEach((row, i) => {
    const bhcId = cell(row, 0);
    if (bhcId === '') return; // gap row (spec 4.5a: skip blank BHC_ID)

    const googleRowRaw = cell(row, 3);
    const googleRowNum = Number.parseInt(googleRowRaw, 10);

    const entry: MasterIdEntry = {
      bhcId,
      fullName: cell(row, 1),
      location: cell(row, 2).toUpperCase(),
      googleRow: Number.isFinite(googleRowNum) && googleRowNum > 0 ? googleRowNum : null,
      attioRecordId: cell(row, 4),
      masterRow: i + 2, // range starts at row 2
    };

    byBhcId.set(entry.bhcId, entry);

    if (entry.attioRecordId !== '') {
      if (byAttioRecordId.has(entry.attioRecordId)) {
        // Two Master_ID rows claiming one Attio record is exactly the pointer
        // ambiguity that corrupts data. Refuse to resolve either.
        duplicates.add(entry.attioRecordId);
      } else {
        byAttioRecordId.set(entry.attioRecordId, entry);
      }
    }
  });

  for (const dup of duplicates) byAttioRecordId.delete(dup);

  return {
    byBhcId,
    byAttioRecordId,
    duplicateAttioRecordIds: [...duplicates],
    rowCount: byBhcId.size,
  };
}

export interface TierIndex {
  readonly byBhcId: ReadonlyMap<string, Tier>;
  readonly headerTitle: string;
  readonly columnIndex: number;
}

/**
 * Build bhc_id → tier from Contacts.
 *
 * SPEC NOTE: 4b says "Read Contacts!A3:V once... Parse header row 1" — but row 1
 * is not inside A3:V. We issue a separate 1-row header read (Contacts!A1:V1) and
 * resolve the tier column by title, never by a hardcoded letter. Two reads, not
 * one. See docs/pass4-notes.md #5.
 */
export async function loadTierIndex(sheets: SheetsClient): Promise<TierIndex> {
  const headerRows = await sheets.read(RANGES.contactsHeader, 'FORMATTED_VALUE');
  const header = headerRows[0];
  if (!header) {
    throw new Error(`Contacts header row is empty (${RANGES.contactsHeader}) — cannot locate the tier column.`);
  }

  const titles = header.map((h) => String(h ?? '').trim());
  let columnIndex = -1;
  let headerTitle = '';
  for (const candidate of TIER_HEADER_CANDIDATES) {
    const idx = titles.findIndex((t) => t.toLowerCase() === candidate.toLowerCase());
    if (idx !== -1) {
      columnIndex = idx;
      headerTitle = titles[idx] ?? candidate;
      break;
    }
  }

  if (columnIndex === -1) {
    throw new Error(
      `No tier column in ${RANGES.contactsHeader}. Looked for ${TIER_HEADER_CANDIDATES.join(' or ')}; ` +
        `found: ${titles.filter((t) => t !== '').join(', ') || '(all blank)'}`,
    );
  }

  const rows = await sheets.read(RANGES.contactsData, 'FORMATTED_VALUE');
  const byBhcId = new Map<string, Tier>();
  for (const row of rows) {
    const bhcId = cell(row, 0);
    if (bhcId === '') continue;
    const raw = cell(row, columnIndex);
    if (raw === '') continue; // absent → let the caller apply DEFAULT_TIER
    byBhcId.set(bhcId, normalizeTier(raw));
  }

  return { byBhcId, headerTitle, columnIndex };
}
