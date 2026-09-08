/**
 * PER-LOCATOR CONTENT HASHES — the real deliverable of Plan indexing.
 *
 * ⚠ THIS IS BUILT EVEN THOUGH THE UPDATE HALF IS NOT AUTOMATED, and that is
 * deliberate. A log entry is appended and never changes, so "seen once" means
 * "done forever". A PLAN CHAPTER IS REWRITTEN IN PLACE — Chapters 1, 3, 4, 5.3
 * and 11 were substantially rewritten between 2026-08-25 and 08-27 while their
 * index references predate every one of those edits, and nothing noticed.
 *
 * The routine will not repair that (see docs/plan-indexing-spec.md §4: removing
 * a superseded reference needs a delete capability the transport deliberately
 * lacks, and a provenance record that cannot be retrofitted onto 291
 * hand-written references). What it CAN do is record what each section looked
 * like when it was indexed, so the QC pass can name the ones that have moved.
 *
 * A stale index that says which parts are stale is a different thing from a
 * stale index.
 */

import { createHash } from 'node:crypto';

import { cell, type SheetRow } from '../../lib/sheets.js';

export const PLAN_STATE_TAB = 'Plan_Index_State';
export const PLAN_STATE_RANGES = {
  header: `${PLAN_STATE_TAB}!A1:H1`,
  data: `${PLAN_STATE_TAB}!A2:H`,
} as const;

export const PLAN_STATE_HEADER = [
  'locator',
  'heading_id',
  'content_hash',
  'unit_chars',
  'truncated_to',
  'indexed_by',
  'first_seen',
  'last_seen',
] as const;

export const PLAN_STATE_COLS = {
  locator: 0,
  headingId: 1,
  contentHash: 2,
  unitChars: 3,
  truncatedTo: 4,
  indexedBy: 5,
  firstSeen: 6,
  lastSeen: 7,
} as const;

export const PLAN_STATE_COLUMNS = PLAN_STATE_HEADER.length;

/**
 * ⚠ PROVENANCE, AND THE ONE VALUE THAT MAKES THE 291 SAFE.
 *
 * `hand` means: this section was already referenced in the index when the
 * routine first saw it, so a human wrote those references and the routine
 * cannot prove otherwise. Such a section is PERMANENTLY UNTOUCHABLE — the
 * routine records its hash for drift reporting and adds nothing.
 *
 * `routine` means: the routine added the references itself and could, in
 * principle, reason about them later. Nothing does yet.
 */
export type IndexedBy = 'hand' | 'routine';

export interface PlanSectionState {
  readonly locator: string;
  readonly headingId: string;
  readonly contentHash: string;
  readonly unitChars: number;
  readonly truncatedTo: number;
  readonly indexedBy: IndexedBy;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/**
 * ⚠ HASHES THE WHOLE UNIT BODY, whitespace-normalised, NOT the heading alone
 * and NOT the truncated prompt slice.
 *
 * The spec's §2 asks which failure is preferable and answers it: a
 * heading-only hash never fires when a body is rewritten, which is exactly the
 * August case that went unnoticed. A whole-body hash fires on a typo fix too —
 * over-triggering — and that is the failure worth having HERE precisely
 * because nothing is repaired automatically. The hash only ever produces a
 * line in a report, so a false positive costs a glance and a false negative
 * costs a chapter silently misdescribed.
 *
 * Whitespace is normalised so a reflow is not reported as a rewrite.
 */
export function contentHash(body: string): string {
  return createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

export function parsePlanStateRow(row: SheetRow): PlanSectionState | null {
  const locator = cell(row, PLAN_STATE_COLS.locator);
  if (locator === '') return null;
  const by = cell(row, PLAN_STATE_COLS.indexedBy).toLowerCase();
  return {
    locator,
    headingId: cell(row, PLAN_STATE_COLS.headingId),
    contentHash: cell(row, PLAN_STATE_COLS.contentHash),
    unitChars: Number(cell(row, PLAN_STATE_COLS.unitChars)) || 0,
    truncatedTo: Number(cell(row, PLAN_STATE_COLS.truncatedTo)) || 0,
    // ⚠ ANYTHING UNRECOGNISED IS TREATED AS `hand`, never as `routine`. The
    // permissive direction here would let the routine believe it owns
    // references a human wrote.
    indexedBy: by === 'routine' ? 'routine' : 'hand',
    firstSeen: cell(row, PLAN_STATE_COLS.firstSeen),
    lastSeen: cell(row, PLAN_STATE_COLS.lastSeen),
  };
}

export function serializePlanStateRow(s: PlanSectionState): unknown[] {
  const cells = new Array<unknown>(PLAN_STATE_COLUMNS).fill('');
  cells[PLAN_STATE_COLS.locator] = s.locator;
  cells[PLAN_STATE_COLS.headingId] = s.headingId;
  cells[PLAN_STATE_COLS.contentHash] = s.contentHash;
  cells[PLAN_STATE_COLS.unitChars] = s.unitChars;
  cells[PLAN_STATE_COLS.truncatedTo] = s.truncatedTo;
  cells[PLAN_STATE_COLS.indexedBy] = s.indexedBy;
  cells[PLAN_STATE_COLS.firstSeen] = s.firstSeen;
  cells[PLAN_STATE_COLS.lastSeen] = s.lastSeen;
  return cells;
}

export type DriftVerdict = 'unseen' | 'unchanged' | 'CHANGED';

/** Has this section moved since it was indexed? Reported, never acted on. */
export function driftOf(prior: PlanSectionState | undefined, hash: string): DriftVerdict {
  if (!prior) return 'unseen';
  return prior.contentHash === hash ? 'unchanged' : 'CHANGED';
}
