/**
 * PASS 1 + PASS 2 — load Master_ID and run the structural checks S1-S5.
 * Pure: no API calls, per the spec ("no API calls needed").
 */

import { cell } from '../../lib/sheets.js';
import type { Finding, MasterRow } from './types.js';

/**
 * Retired identities. Location field ONLY — never inferred from blank pointers.
 *
 * Row 962 (BHC-00920, Rachel Marantz) has blank pointers with a live Location
 * and is a REAL defect that must keep being flagged. Retirement is declared,
 * never deduced. This is also what keeps S3's silence deliberate rather than
 * accidental: S3 is four positive matches on GOOGLE/ATTIO/BOTH, so a
 * superseded row falls through all four by luck. Remove the PASS 1 skip and
 * every retirement becomes a HIGH-severity false positive.
 */
export const SUPERSEDED = 'SUPERSEDED';

export interface LoadedMaster {
  readonly rows: readonly MasterRow[];
  readonly supersededCount: number;
  readonly gapRowsSkipped: number;
  readonly blankBhcIds: number;
  readonly blankNames: number;
  readonly byBhcId: ReadonlyMap<string, readonly MasterRow[]>;
  readonly byAttioId: ReadonlyMap<string, readonly MasterRow[]>;
  readonly totalRowsRead: number;
}

export function loadMasterRows(raw: readonly (readonly unknown[])[]): LoadedMaster {
  const rows: MasterRow[] = [];
  let supersededCount = 0;
  let gapRowsSkipped = 0;
  let blankBhcIds = 0;
  let blankNames = 0;

  raw.forEach((r, i) => {
    const bhcId = cell(r, 0);
    const fullName = cell(r, 1);
    const location = cell(r, 2).toUpperCase();
    const attioRecordId = cell(r, 4);

    // Spec: fully blank rows (no BHC_ID AND no Full_Name AND no Attio_Record_ID)
    // are intentional gap rows, not data errors.
    if (bhcId === '' && fullName === '' && attioRecordId === '') { gapRowsSkipped += 1; return; }
    if (location === SUPERSEDED) { supersededCount += 1; return; }

    if (bhcId === '') blankBhcIds += 1;
    if (fullName === '') blankNames += 1;

    const gr = Number.parseInt(cell(r, 3), 10);
    rows.push({
      bhcId, fullName, location,
      googleRow: Number.isFinite(gr) ? gr : null,
      attioRecordId, notes: cell(r, 5),
      masterRow: i + 2, // range starts at row 2
    });
  });

  const byBhcId = new Map<string, MasterRow[]>();
  const byAttioId = new Map<string, MasterRow[]>();
  for (const row of rows) {
    if (row.bhcId !== '') byBhcId.set(row.bhcId, [...(byBhcId.get(row.bhcId) ?? []), row]);
    if (row.attioRecordId !== '') byAttioId.set(row.attioRecordId, [...(byAttioId.get(row.attioRecordId) ?? []), row]);
  }

  return {
    rows, supersededCount, gapRowsSkipped, blankBhcIds, blankNames,
    byBhcId, byAttioId, totalRowsRead: raw.length,
  };
}

export function structuralChecks(loaded: LoadedMaster): readonly Finding[] {
  const out: Finding[] = [];

  // S1 — duplicate BHC_ID. Flag ALL copies, per spec.
  for (const [bhcId, dupes] of loaded.byBhcId) {
    if (dupes.length < 2) continue;
    const rowList = dupes.map((d) => d.masterRow).join(', ');
    for (const row of dupes) {
      out.push({ code: 'S1', row, expected: 'unique', found: `rows ${rowList}`, notes: `${dupes.length} rows share ${bhcId}` });
    }
  }

  // S4 — duplicate Attio pointer.
  for (const [attioId, dupes] of loaded.byAttioId) {
    if (dupes.length < 2) continue;
    const rowList = dupes.map((d) => d.masterRow).join(', ');
    for (const row of dupes) {
      out.push({ code: 'S4', row, expected: 'unique', found: `rows ${rowList}`, notes: `${dupes.length} rows share Attio record ${attioId}` });
    }
  }

  for (const row of loaded.rows) {
    // S2 — missing BHC_ID.
    if (row.bhcId === '') {
      out.push({ code: 'S2', row, expected: 'a BHC_ID', found: '(blank)', notes: 'row has no identity anchor' });
    }

    // S3 — location/pointer mismatch. Four positive matches, exactly as specced.
    const loc = row.location;
    const hasGoogle = row.googleRow !== null;
    const hasAttio = row.attioRecordId !== '';
    if ((loc === 'GOOGLE' || loc === 'BOTH') && !hasGoogle) {
      out.push({ code: 'S3', row, expected: 'Google_Row populated', found: '(blank)', notes: `Location=${loc} but Google_Row is blank` });
    }
    if ((loc === 'ATTIO' || loc === 'BOTH') && !hasAttio) {
      out.push({ code: 'S3', row, expected: 'Attio_Record_ID populated', found: '(blank)', notes: `Location=${loc} but Attio_Record_ID is blank` });
    }
    if (loc === 'GOOGLE' && hasAttio) {
      out.push({ code: 'S3', row, expected: 'no Attio_Record_ID', found: row.attioRecordId, notes: 'Location=GOOGLE but an Attio pointer is present' });
    }
    if (loc === 'ATTIO' && hasGoogle) {
      out.push({ code: 'S3', row, expected: 'no Google_Row', found: String(row.googleRow), notes: 'Location=ATTIO but a Google_Row is present' });
    }

    // S5 — implausible Google_Row (rows 1-2 are header/ARRAYFORMULA spill).
    if (row.googleRow !== null && row.googleRow < 3) {
      out.push({ code: 'S5', row, expected: '>= 3', found: String(row.googleRow), notes: 'rows 1-2 are header/formula' });
    }
  }

  return out;
}
