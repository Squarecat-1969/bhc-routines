/**
 * PASS 3 — Google pointer verification, plus the Google identity load I1 needs.
 *
 * ONE read of Contacts!A3:DI serves both. Column letters are resolved from the
 * header BY NAME, never hardcoded — the live tab has 150+ columns and they move.
 */

import { cell } from '../../lib/sheets.js';
import type { Finding, GoogleIdentity, MasterRow } from './types.js';

const FIRST_DATA_ROW = 3; // row 1 header, row 2 ARRAYFORMULA spill

export interface ContactsIndex {
  /** sheet row -> col A (Contact_ID), for the pointer check. */
  readonly colA: ReadonlyMap<number, string>;
  /** sheet row -> identity fields, for I1. */
  readonly identity: ReadonlyMap<number, GoogleIdentity>;
  /** Last populated data row — G3's bound. */
  readonly lastRow: number;
  readonly resolvedColumns: Readonly<Record<string, number>>;
  readonly missingHeaders: readonly string[];
}

const HEADERS = {
  firstName: 'First_Name',
  lastName: 'Last_Name',
  title: 'Title',
  company: 'Company',
  primaryEmail: 'Primary_Email',
} as const;

export function buildContactsIndex(
  header: readonly (readonly unknown[])[],
  data: readonly (readonly unknown[])[],
): ContactsIndex {
  const headerRow = header[0] ?? [];
  const byTitle = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const t = String(h ?? '').trim();
    if (t !== '' && !byTitle.has(t)) byTitle.set(t, i);
  });

  const resolved: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, title] of Object.entries(HEADERS)) {
    const idx = byTitle.get(title);
    if (idx === undefined) missing.push(title);
    else resolved[key] = idx;
  }

  const colA = new Map<number, string>();
  const identity = new Map<number, GoogleIdentity>();
  let lastRow = FIRST_DATA_ROW - 1;

  data.forEach((row, i) => {
    const sheetRow = FIRST_DATA_ROW + i;
    const id = cell(row, 0);
    colA.set(sheetRow, id);
    if (id !== '') lastRow = sheetRow;
    const at = (key: keyof typeof HEADERS): string => {
      const idx = resolved[key];
      return idx === undefined ? '' : cell(row, idx);
    };
    identity.set(sheetRow, {
      firstName: at('firstName'), lastName: at('lastName'),
      title: at('title'), company: at('company'), primaryEmail: at('primaryEmail'),
    });
  });

  return { colA, identity, lastRow, resolvedColumns: resolved, missingHeaders: missing };
}

/** G1 / G2 / G3 for every row claiming a Google pointer. */
export function googleChecks(rows: readonly MasterRow[], idx: ContactsIndex): readonly Finding[] {
  const out: Finding[] = [];
  for (const row of rows) {
    if (row.googleRow === null) continue; // S3's job, not G's
    if (row.googleRow < FIRST_DATA_ROW) continue; // S5 already flagged it

    if (row.googleRow > idx.lastRow) {
      out.push({
        code: 'G3', row, expected: `<= ${idx.lastRow}`, found: String(row.googleRow),
        notes: `Google_Row exceeds the last stamped Contacts row (${idx.lastRow})`,
      });
      continue;
    }

    const actual = idx.colA.get(row.googleRow) ?? '';
    if (actual === '') {
      out.push({ code: 'G2', row, expected: row.bhcId, found: '(blank)', notes: `Contacts row ${row.googleRow} has no Contact_ID` });
      continue;
    }
    if (actual !== row.bhcId) {
      out.push({
        code: 'G1', row, expected: row.bhcId, found: actual,
        notes: `Contacts row ${row.googleRow} holds ${actual}`,
      });
    }
  }
  return out;
}
