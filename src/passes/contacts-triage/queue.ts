/**
 * STEP 5 + STEP 6 — the queue rows, and the merge that makes re-runs safe.
 *
 * The one invariant everything here protects: BOBBY'S DECISIONS SURVIVE
 * RE-SCORING. A row whose status is anything but `pending` is re-emitted from
 * its own original cells, byte for byte, so a re-run cannot quietly rewrite a
 * verdict, a first_seen, or a skip window. Only two things move a non-pending
 * row: a skip whose window has expired, and a skip that new evidence has made
 * decidable — both named explicitly in STEP 6.
 */

import { QUEUE_COLS, QUEUE_COLUMNS } from '../../config/triage-constants.js';
import { isCivilDate, isSameOrBefore, type CivilDate } from '../../lib/dates.js';
import { cell, type SheetRow } from '../../lib/sheets.js';
import { bandFor } from './score.js';
import type {
  BandDistribution,
  ExistingQueueRow,
  MergeAction,
  MergedRow,
  QueueColumn,
  QueueRow,
  ScoredContact,
} from './types.js';

const BOOL = (v: boolean): string => (v ? 'TRUE' : 'FALSE');

export function serializeQueueRow(row: QueueRow): unknown[] {
  const cells = new Array<unknown>(QUEUE_COLUMNS).fill('');
  cells[QUEUE_COLS.attioRecordId] = row.attioRecordId;
  cells[QUEUE_COLS.name] = row.name;
  cells[QUEUE_COLS.primaryEmail] = row.primaryEmail;
  cells[QUEUE_COLS.company] = row.company;
  cells[QUEUE_COLS.keeperProbability] = row.keeperProbability;
  cells[QUEUE_COLS.deterministicScore] = row.deterministicScore;
  cells[QUEUE_COLS.llmScore] = row.llmScore ?? '';
  cells[QUEUE_COLS.scoreSource] = row.scoreSource;
  cells[QUEUE_COLS.clamped] = BOOL(row.clamped);
  cells[QUEUE_COLS.column] = row.column;
  cells[QUEUE_COLS.hasName] = BOOL(row.hasName);
  // Blank, not 0: a count we cannot compute must not be written as a count of zero.
  cells[QUEUE_COLS.interactionCount] = row.interactionCount ?? '';
  cells[QUEUE_COLS.interactionSpanDays] = row.interactionSpanDays ?? '';
  cells[QUEUE_COLS.direction] = row.direction === 'unknown' ? '' : row.direction;
  cells[QUEUE_COLS.provenanceSubject] = row.provenanceSubject;
  cells[QUEUE_COLS.provenanceDate] = row.provenanceDate;
  cells[QUEUE_COLS.provenanceRecipients] = row.provenanceRecipients ?? '';
  cells[QUEUE_COLS.reason] = row.reason;
  cells[QUEUE_COLS.status] = row.status;
  cells[QUEUE_COLS.skipUntil] = row.skipUntil;
  cells[QUEUE_COLS.firstSeen] = row.firstSeen;
  cells[QUEUE_COLS.lastScored] = row.lastScored;
  cells[QUEUE_COLS.provenanceSource] = row.provenanceSource;
  cells[QUEUE_COLS.connectionStrength] = row.connectionStrength;
  return cells;
}

function numberAt(row: SheetRow, index: number): number {
  const n = Number(cell(row, index));
  return Number.isFinite(n) ? n : 0;
}

function bandAt(row: SheetRow): QueueColumn {
  const raw = cell(row, QUEUE_COLS.column).toLowerCase();
  if (raw === 'keepers' || raw === 'junk' || raw === 'unclear') return raw;
  return bandFor(numberAt(row, QUEUE_COLS.keeperProbability));
}

/** Rows with no attio_record_id are blank padding, not data. */
export function parseExistingQueueRow(row: SheetRow): ExistingQueueRow | null {
  const attioRecordId = cell(row, QUEUE_COLS.attioRecordId);
  if (attioRecordId === '') return null;

  const padded = [...row];
  while (padded.length < QUEUE_COLUMNS) padded.push('');

  return {
    attioRecordId,
    cells: padded.slice(0, QUEUE_COLUMNS),
    status: cell(row, QUEUE_COLS.status),
    column: bandAt(row),
    keeperProbability: numberAt(row, QUEUE_COLS.keeperProbability),
    skipUntil: cell(row, QUEUE_COLS.skipUntil),
    firstSeen: cell(row, QUEUE_COLS.firstSeen),
    lastScored: cell(row, QUEUE_COLS.lastScored),
  };
}

export function buildQueueRow(
  scored: ScoredContact,
  opts: { readonly today: CivilDate; readonly firstSeen: string; readonly status: QueueRow['status'] },
): QueueRow {
  const { contact, signals } = scored;
  return {
    attioRecordId: contact.attioRecordId,
    name: contact.name ?? '',
    primaryEmail: contact.primaryEmail ?? '',
    company: contact.company ?? '',
    keeperProbability: scored.finalScore,
    deterministicScore: scored.deterministic.score,
    llmScore: scored.llm?.rawScore ?? null,
    scoreSource: scored.scoreSource,
    clamped: scored.clamped,
    column: scored.column,
    hasName: signals.hasName,
    // Message counts and recipient counts need message metadata, which is
    // permanently unavailable — these stay blank rather than lying with a 0.
    interactionCount: null,
    interactionSpanDays: signals.spanKnown ? signals.spanDays : null,
    direction: signals.lastDirection,
    provenanceSubject: signals.provenance?.text ?? '',
    provenanceDate: signals.provenance?.date ?? '',
    provenanceRecipients: null,
    provenanceSource: signals.provenance?.source ?? 'none',
    connectionStrength: signals.strength ?? '',
    reason: scored.reason,
    status: opts.status,
    // Cleared on every write of a pending row: a row that is pending is not
    // skipped, and a stale skip_until would misfire the next reactivation check.
    skipUntil: '',
    firstSeen: opts.firstSeen === '' ? opts.today : opts.firstSeen,
    lastScored: opts.today,
  };
}

/**
 * Has new interaction data arrived since this row was last scored?
 *
 * Now solely a date comparison: Attio's last-interaction date moving past the
 * row's own last_scored. The old count-increase test went with the message
 * metadata. This is what makes an undecidable card decidable, so it overrides
 * an unexpired skip window rather than waiting it out (STEP 6: "OR immediately
 * if new interaction data has arrived since").
 */
export function hasNewEvidence(existing: ExistingQueueRow, scored: ScoredContact): boolean {
  const last = scored.signals.lastAt;
  if (!last || !isCivilDate(existing.lastScored)) return false;
  return !isSameOrBefore(last, existing.lastScored);
}

export interface MergeInput {
  readonly scored: readonly ScoredContact[];
  readonly existing: readonly ExistingQueueRow[];
  /** Record IDs observed in Attio WITH a bhc_contact_id — positive evidence the contact is done. */
  readonly bridgedIds: ReadonlySet<string>;
  /** Record IDs in Contact_Exclusions, or hard-excluded this run. */
  readonly excludedIds: ReadonlySet<string>;
  readonly today: CivilDate;
}

export interface MergeResult {
  readonly rows: readonly MergedRow[];
  readonly counts: Record<MergeAction, number>;
  readonly warnings: readonly string[];
}

const EMPTY_COUNTS = (): Record<MergeAction, number> => ({
  new: 0,
  rescored: 0,
  'preserved-decision': 0,
  'preserved-skip': 0,
  'reactivated-skip-expired': 0,
  'reactivated-new-evidence': 0,
  'dropped-bridged': 0,
  'dropped-excluded': 0,
  'kept-unseen': 0,
});

export function mergeQueue(input: MergeInput): MergeResult {
  const { scored, existing, bridgedIds, excludedIds, today } = input;
  const counts = EMPTY_COUNTS();
  const warnings: string[] = [];
  const rows: MergedRow[] = [];

  const existingById = new Map(existing.map((e) => [e.attioRecordId, e]));
  const scoredById = new Map(scored.map((s) => [s.contact.attioRecordId, s]));

  const emit = (
    attioRecordId: string,
    action: MergeAction,
    cells: readonly unknown[] | null,
    column: QueueColumn,
    keeperProbability: number,
  ): void => {
    counts[action] += 1;
    rows.push({ attioRecordId, action, cells, column, keeperProbability });
  };

  // --- Contacts scored this run.
  for (const s of scored) {
    const id = s.contact.attioRecordId;
    const prior = existingById.get(id);

    if (!prior) {
      const row = buildQueueRow(s, { today, firstSeen: today, status: 'pending' });
      emit(id, 'new', serializeQueueRow(row), row.column, row.keeperProbability);
      continue;
    }

    const status = prior.status.trim().toLowerCase();

    if (status === '' || status === 'pending') {
      const row = buildQueueRow(s, { today, firstSeen: prior.firstSeen, status: 'pending' });
      emit(id, 'rescored', serializeQueueRow(row), row.column, row.keeperProbability);
      continue;
    }

    if (status === 'skipped') {
      const expired = isCivilDate(prior.skipUntil) && isSameOrBefore(prior.skipUntil, today);
      const newEvidence = hasNewEvidence(prior, s);
      if (expired || newEvidence) {
        const row = buildQueueRow(s, { today, firstSeen: prior.firstSeen, status: 'pending' });
        emit(
          id,
          newEvidence ? 'reactivated-new-evidence' : 'reactivated-skip-expired',
          serializeQueueRow(row),
          row.column,
          row.keeperProbability,
        );
      } else {
        emit(id, 'preserved-skip', prior.cells, prior.column, prior.keeperProbability);
      }
      continue;
    }

    // queued_keep / queued_archive / processed — and anything unrecognized,
    // which is deliberately treated as a decision rather than as pending.
    if (status !== 'queued_keep' && status !== 'queued_archive' && status !== 'processed') {
      warnings.push(`row ${id} has unrecognized status "${prior.status}" — preserved untouched, not re-scored`);
    }
    emit(id, 'preserved-decision', prior.cells, prior.column, prior.keeperProbability);
  }

  // --- Rows already in the tab that were not scored this run.
  for (const prior of existing) {
    if (scoredById.has(prior.attioRecordId)) continue;

    if (bridgedIds.has(prior.attioRecordId)) {
      emit(prior.attioRecordId, 'dropped-bridged', null, prior.column, prior.keeperProbability);
      continue;
    }
    if (excludedIds.has(prior.attioRecordId)) {
      emit(prior.attioRecordId, 'dropped-excluded', null, prior.column, prior.keeperProbability);
      continue;
    }

    // Not seen in Attio at all this run. A row is only ever dropped on
    // positive evidence — deleted-in-Attio and a half-completed enumeration
    // look identical from here, and one of them silently discards Bobby's
    // pending decisions.
    emit(prior.attioRecordId, 'kept-unseen', prior.cells, prior.column, prior.keeperProbability);
    warnings.push(
      `row ${prior.attioRecordId} was not seen in this run's Attio enumeration — kept in place, not dropped`,
    );
  }

  return { rows: sortMerged(rows), counts, warnings };
}

/**
 * STEP 5's ordering: "keepers and unclear DESC, junk ASC (shakiest junk calls
 * surface first, where they'll actually be read)".
 *
 * FLAGGED CONTRADICTION, implemented literally: ascending by score puts the
 * most confident junk (a 3) first, not the shakiest (a 24). The literal
 * instruction wins here only because the same paragraph says sorting is Aida's
 * job and this routine's real obligation is to "record enough for it" — which
 * it does, in `column` and `keeper_probability`. Flip the junk comparator if
 * Bobby confirms the parenthetical was the intent. See
 * docs/contacts-triage-notes.md #4.
 */
export function sortMerged(rows: readonly MergedRow[]): MergedRow[] {
  const rank: Record<QueueColumn, number> = { keepers: 0, unclear: 1, junk: 2 };
  return [...rows]
    .filter((r) => r.cells !== null)
    .sort((a, b) => {
      if (rank[a.column] !== rank[b.column]) return rank[a.column] - rank[b.column];
      if (a.column === 'junk') return a.keeperProbability - b.keeperProbability;
      return b.keeperProbability - a.keeperProbability;
    })
    .concat(rows.filter((r) => r.cells === null));
}

export function distributionOf(scores: readonly number[]): BandDistribution {
  const buckets = new Array<number>(11).fill(0);
  let keepers = 0;
  let unclear = 0;
  let junk = 0;

  for (const score of scores) {
    const bucket = Math.min(10, Math.max(0, Math.floor(score / 10)));
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    const band = bandFor(score);
    if (band === 'keepers') keepers += 1;
    else if (band === 'junk') junk += 1;
    else unclear += 1;
  }

  return { keepers, unclear, junk, buckets };
}
