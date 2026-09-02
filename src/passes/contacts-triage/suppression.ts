/**
 * STEP 1b — SUPPRESSION. Runs before scoring and before duplicate detection.
 *
 * The failure this exists to stop is recorded, dated, and repeated:
 *
 *   Raymond Yang was deliberately scrapped 2026-08-05 — "TNB staff, not an
 *   external contact" — with the reasoning written into two Master_ID rows,
 *   his Attio record deleted by hand and Contacts row 383 emptied. Attio's
 *   email sync has since re-created him TWICE: 2026-08-30 and 2026-09-01.
 *
 * Nothing consulted the prior human decision, so the same decision gets
 * demanded again every time Attio notices him. Suppression reads the two
 * places a human decision is durably recorded — `Master_ID` rows set to
 * `Location: SUPERSEDED`, and `Contact_Exclusions` — and drops the record
 * before a single scoring signal is computed.
 *
 * ⚠ A SUPPRESSED RECORD IS NEVER SILENTLY ABSENT. Every suppression carries
 * the annotation that justifies it, quoted from the source row, so the run
 * report says *why* rather than merely reporting a smaller number. A
 * suppression nobody can audit is indistinguishable from a bug that drops
 * records, and this pass has exactly one job that matters: not queueing things
 * a human already ruled on.
 *
 * ⚠ NOT EVERY `SUPERSEDED` ROW IS A RETIRED IDENTITY. Measured live
 * 2026-09-01, the 31 SUPERSEDED rows are three different things:
 *
 *   19  blank BHC_ID + name in column B  → RETIRED IDENTITY. The signal.
 *   11  BHC_ID in column A + BLANK column B → merge tombstone ("Merged into
 *       BHC-01195 · was Jenny Kim"). That person still exists under another
 *       BHC_ID; they were not retired. NOT a suppression source.
 *    1  BOTH populated — row 962, BHC-00920 "Rachel Marantz", annotation
 *       `A3-FIXED`. An ACTIVE contact whose Location was set to SUPERSEDED
 *       during the 2026-08-30 cleanup. Suppressing on her name would hide a
 *       live contact. NOT a suppression source.
 *
 * So the gate is `blank column A AND non-blank column B`, and it yields
 * exactly the 19 the build spec §2 counts. The other 12 are counted and
 * reported, never matched.
 *
 * ⚠ NAMES ARE READ FROM COLUMN B ONLY, NEVER PARSED OUT OF THE NOTE. The
 * merge tombstones carry a name inside the annotation ("· was Jenny Kim") and
 * nowhere else. Harvesting names from note prose would pull those 11 back in
 * through the exact door the column-B rule closes.
 */

import { MASTER_ID_COLS } from '../../config/triage-constants.js';
import { significantWords, stripDiacritics } from '../../lib/name-verify.js';
import { cell, type SheetRow } from '../../lib/sheets.js';
import type { ExclusionIndex } from './exclusions.js';
import { matchExclusion } from './exclusions.js';
import type { UnbridgedContact } from './types.js';

/** How the retirement was described. Drives the audit line, not the decision. */
export type RetiredKind = 'SCRAPPED' | 'ORPHAN_CLEARED' | 'OTHER';

export interface RetiredIdentity {
  /** 1-indexed Master_ID sheet row, so a report line points at something openable. */
  readonly masterRow: number;
  readonly name: string;
  readonly nameKey: string;
  readonly kind: RetiredKind;
  /** The leading clause of column F, quoted verbatim in the audit line. */
  readonly quote: string;
}

export interface SuppressionIndex {
  readonly byNameKey: ReadonlyMap<string, readonly RetiredIdentity[]>;
  /** Rows that became suppression sources — expected 19. */
  readonly retiredCount: number;
  /** `Merged into …` rows: the person lives under another BHC_ID. Counted, never matched. */
  readonly mergeTombstoneCount: number;
  /** SUPERSEDED rows carrying BOTH a BHC_ID and a name — active, not retired. */
  readonly activeSupersededRows: readonly number[];
  /** Retired rows whose name normalised to nothing, so they can never match. */
  readonly unusableRows: readonly number[];
  readonly supersededTotal: number;
}

/**
 * The matching key: diacritics stripped, then the mandated normaliser, then
 * sorted — so it is EXACT SET EQUALITY over significant words.
 *
 * ⚠ THIS DELIBERATELY DOES NOT USE `verifyName`. That gate passes on ONE
 * significant word in common, which is correct for its job (verifying a pair a
 * human already proposed before writing through a pointer) and wrong for this
 * one. Live proof: "Raymond Yang" (scrapped) and "Raymond Worsdale"
 * (BHC-00679, active at NBCUniversal) share `raymond`, so the loose gate would
 * suppress a live bridged contact. Generating matches needs the strict form;
 * verifying a proposed match needs the loose one. `significantWords` and
 * `stripDiacritics` are reused from name-verify.ts so there is still only one
 * normaliser — only the comparison differs.
 *
 * Diacritics are stripped because "Björn Ahlstedt" is one of the 19 and Attio's
 * own enrichment is the documented source of accent drift.
 */
export function nameKeyOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return '';
  return [...significantWords(stripDiacritics(trimmed))].sort().join(' ');
}

/**
 * The leading clause of an annotation — what gets quoted.
 *
 * Column F accretes: later notes are appended after ` · `, and the
 * 2026-08-30 Location cleanup appended one to all 19. The original decision is
 * the first clause, so the quote stops at the first ` · ` and then at the first
 * sentence end. Row 456 yields exactly "SCRAPPED 2026-08-05: Raymond Yang is
 * TNB staff, not an external contact".
 */
export function leadAnnotation(note: string): string {
  const firstClause = (note.split(' · ')[0] ?? '').trim();
  if (firstClause === '') return '';
  // Sentence end = period followed by whitespace. A trailing period is kept off.
  const m = /^(.*?[^.])\.(?:\s|$)/s.exec(firstClause);
  const lead = (m?.[1] ?? firstClause).trim();
  return lead.length > 300 ? `${lead.slice(0, 297)}...` : lead;
}

function kindOf(note: string): RetiredKind {
  if (note.startsWith('SCRAPPED')) return 'SCRAPPED';
  if (note.startsWith('ORPHAN CLEARED')) return 'ORPHAN_CLEARED';
  return 'OTHER';
}

/**
 * Build the index from `Master_ID!A2:F`.
 *
 * Only `Location: SUPERSEDED` rows are considered at all, and of those only
 * the retired-identity shape becomes a source. Everything else is counted so
 * the report can show that the 31 were seen and 12 were deliberately not used.
 */
export function readSuppressionIndex(rows: readonly SheetRow[]): SuppressionIndex {
  const byNameKey = new Map<string, RetiredIdentity[]>();
  const activeSupersededRows: number[] = [];
  const unusableRows: number[] = [];
  let mergeTombstoneCount = 0;
  let supersededTotal = 0;

  rows.forEach((row, i) => {
    if (cell(row, MASTER_ID_COLS.location).trim().toUpperCase() !== 'SUPERSEDED') return;
    supersededTotal += 1;

    const masterRow = i + 2; // the range starts at sheet row 2
    const bhcId = cell(row, MASTER_ID_COLS.bhcId).trim();
    const note = cell(row, MASTER_ID_COLS.notes).trim();
    // ⚠ COLUMN B ONLY. See the header note: the merge tombstones carry a name
    // only inside `note`, and harvesting it there readmits all 11.
    const name = cell(row, MASTER_ID_COLS.fullName).trim();

    // A row still carrying a BHC_ID was not retired.
    if (bhcId !== '') {
      if (name === '') mergeTombstoneCount += 1;
      else activeSupersededRows.push(masterRow);
      return;
    }
    if (name === '') {
      unusableRows.push(masterRow);
      return;
    }

    const nameKey = nameKeyOf(name);
    if (nameKey === '') {
      unusableRows.push(masterRow);
      return;
    }

    const entry: RetiredIdentity = {
      masterRow,
      name,
      nameKey,
      kind: kindOf(note),
      quote: leadAnnotation(note),
    };
    const bucket = byNameKey.get(nameKey);
    if (bucket) bucket.push(entry);
    else byNameKey.set(nameKey, [entry]);
  });

  let retiredCount = 0;
  for (const bucket of byNameKey.values()) retiredCount += bucket.length;

  return {
    byNameKey,
    retiredCount,
    mergeTombstoneCount,
    activeSupersededRows,
    unusableRows,
    supersededTotal,
  };
}

export type SuppressionSource = 'master-id-superseded' | 'contact-exclusions';

export interface Suppression {
  readonly attioRecordId: string;
  readonly name: string;
  readonly email: string;
  readonly source: SuppressionSource;
  readonly matchedOn: 'name' | 'record-id' | 'email';
  /** Human-readable, and it QUOTES the original annotation. The audit line. */
  readonly reason: string;
  /** Every Master_ID row that justified it — Raymond Yang has two (456 and 1585). */
  readonly masterRows: readonly number[];
  readonly kind: RetiredKind | null;
}

/**
 * Decide one contact. Returns null when it survives to STEP 2.
 *
 * `Contact_Exclusions` is checked FIRST because it matches on record id or
 * exact address — precise, no false-positive surface. The Master_ID name match
 * is strictly looser (two people can share a name; this population contains
 * proof), so it is the fallback rather than the first word.
 */
export function classifySuppression(
  contact: UnbridgedContact,
  index: SuppressionIndex,
  exclusions: ExclusionIndex,
): Suppression | null {
  const base = {
    attioRecordId: contact.attioRecordId,
    name: contact.name ?? '',
    email: contact.primaryEmail ?? '',
  };

  const exclusionMatch = matchExclusion(contact, exclusions);
  if (exclusionMatch !== null) {
    return {
      ...base,
      source: 'contact-exclusions',
      matchedOn: exclusionMatch,
      reason: `already ruled on in Contact_Exclusions (matched by ${exclusionMatch})`,
      masterRows: [],
      kind: null,
    };
  }

  const key = nameKeyOf(contact.name);
  if (key === '') return null;
  const retired = index.byNameKey.get(key);
  if (!retired || retired.length === 0) return null;

  const rowList = retired.map((r) => r.masterRow);
  const quoted = retired
    .map((r) => (r.quote === '' ? `Master_ID row ${r.masterRow} (no annotation recorded)` : `"${r.quote}"`))
    .join(' | ');

  return {
    ...base,
    source: 'master-id-superseded',
    matchedOn: 'name',
    reason:
      `retired identity — Master_ID row(s) ${rowList.join(', ')} set to Location: SUPERSEDED. ` +
      `Original annotation: ${quoted}`,
    masterRows: rowList,
    kind: retired[0]!.kind,
  };
}
