/**
 * STEP 3 PART A — writing STEP 1c's duplicate candidates into
 * `Contacts_Triage_Queue`, and keeping a dismissal dismissed.
 *
 * Step 2 detected and classified; it never wrote. This is the write.
 *
 * ⚠ THE DUPLICATE QUESTION HAS ITS OWN STATUS COLUMN, AND IT HAS TO.
 *
 * The brief says "skipUntil and status already exist on this tab — use them",
 * and the MECHANISM is reused exactly: the same vocabulary, the same
 * preserve-a-decision rule, the same expiry check. What is NOT reused is the
 * COLUMN, and the reason is measured rather than aesthetic.
 *
 * `status` (S) answers *"should this record become a contact?"*. The duplicate
 * question is *"is this record the same person as one we already have?"*.
 * Live on 2026-09-04, 2 of the 18 candidates already carried
 * `status: processed` from the 2026-08-09 triage run — and one of them is
 * Chuck Granade, a HIGH-confidence typo record and the flagship case of the
 * whole addendum. On a shared column his duplicate question is never asked,
 * because the merge (correctly) preserves a processed row byte for byte. The
 * other direction is worse: answering one question would silently answer the
 * other. That is the same conflation step 2 found in `Contact_Exclusions`, and
 * putting it in a second place would not make it true.
 *
 * ⚠ A CANDIDATE IS WRITTEN EVEN WHEN THE RECORD IS SUPPRESSED OR EXCLUDED.
 * 16 of the 18 are. `Contact_Exclusions` records "do not make this a new
 * contact"; it does not record "this address is not missing from an existing
 * contact". A duplicate-only row therefore carries BLANK triage columns —
 * blank `column`, blank `status`, blank `keeper_probability` — so it appears in
 * no triage bucket and answers no triage question. It exists to carry the
 * duplicate half and the memory of what was decided about it.
 *
 * ⚠ THE TRIAGE HALF OF AN EXISTING ROW IS NEVER TOUCHED HERE. Where a
 * candidate lands on a record that already has a queue row, columns A-X are
 * re-emitted from that row's own cells, byte for byte. Only Y-AS are written.
 */

import {
  DUP_COLS,
  DUPLICATE_SKIP_DAYS,
  QUEUE_COLS,
  QUEUE_COLUMNS,
  type DuplicateClassification,
} from '../../config/triage-constants.js';
import { isCivilDate, isSameOrBefore, type CivilDate } from '../../lib/dates.js';
import { cell, type SheetRow } from '../../lib/sheets.js';
import type { DuplicateCandidate } from './duplicates.js';

/**
 * Vocabulary for `duplicate_status`. `pending` is ours; every `resolved_*` and
 * `skipped` value is written by Aida when a human answers the card.
 *
 * ⚠ ANYTHING UNRECOGNISED IS TREATED AS A DECISION AND PRESERVED, never
 * coerced to pending — the same rule the triage merge uses, and for the same
 * reason: a typo in Bobby's column must not be enough to re-ask a question he
 * has already answered.
 */
export const DUPLICATE_PENDING = 'pending';
export const DUPLICATE_SKIPPED = 'skipped';

/** Which card the row belongs on. TYPO_DOMAIN gets two actions; the rest get four. */
export function classificationOf(candidate: DuplicateCandidate): DuplicateClassification {
  return candidate.kind === 'exclude-typo-domain' ? 'TYPO_DOMAIN' : 'DUPLICATE_CANDIDATE';
}

/**
 * The `bhc_contact_id` a merge would SILENTLY DISCARD.
 *
 * Attio's `bhc_contact_id` is `type: text`, `is_unique: false`, single-value:
 * on a merge the primary's value wins and the secondary's is dropped with no
 * error. That can only bite when the candidate names TWO OR MORE bridged
 * records, because the subject is unbridged by construction and has no ID to
 * compete.
 *
 * ⚠ MEASURED LIVE 2026-09-04: this fires on ZERO of the 18 candidates. The
 * step 3 brief expects "two of the four real candidates" to be in that state;
 * they are not. The field is implemented because the state is reachable — four
 * name keys in the workspace are held by two bridged records each — and it is
 * reported as empty rather than quietly omitted.
 */
export function droppedSecondBhcId(candidate: DuplicateCandidate): string {
  const ids = candidate.bridgedMatches.map((b) => b.bhcId).filter((b): b is string => !!b);
  return ids.length > 1 ? ids.slice(1).join(', ') : '';
}

const joinLines = (lines: readonly string[]): string => lines.join('\n');

export interface DuplicateCellsOptions {
  readonly today: CivilDate;
  readonly status: string;
  readonly skipUntil: string;
  readonly firstSeen: string;
}

/** The 21 duplicate cells, Y-AS, in order. */
export function serializeDuplicateCells(
  candidate: DuplicateCandidate,
  opts: DuplicateCellsOptions,
): unknown[] {
  const cells = new Array<unknown>(QUEUE_COLUMNS - DUP_COLS.status).fill('');
  const put = (index: number, value: unknown): void => {
    cells[index - DUP_COLS.status] = value;
  };

  put(DUP_COLS.status, opts.status);
  put(DUP_COLS.skipUntil, opts.skipUntil);
  put(DUP_COLS.classification, classificationOf(candidate));
  put(DUP_COLS.kind, candidate.kind);
  put(DUP_COLS.confidence, candidate.confidence);

  const matches = [...candidate.bridgedMatches, ...candidate.unbridgedSiblings];
  put(DUP_COLS.matchRecordIds, matches.map((m) => m.attioRecordId).join(', '));
  put(DUP_COLS.matchBhcIds, candidate.bridgedMatches.map((b) => b.bhcId ?? '').filter((b) => b !== '').join(', '));
  put(DUP_COLS.droppedSecondBhcId, droppedSecondBhcId(candidate));
  put(DUP_COLS.repointTo, candidate.repointTo ?? '');
  // The known-good address a typo record should have been. Blank for everything else.
  put(DUP_COLS.referenceEmail, candidate.crmTypos.map((t) => t.referenceEmail).join(', '));

  put(DUP_COLS.corroboration, joinLines(candidate.corroboration));
  // ⚠ What tells the records APART, carried in full. Rejection has to be as
  // cheap as acceptance, and three of seven name candidates are wrong.
  put(DUP_COLS.distinguishing, joinLines(candidate.distinguishing));
  put(DUP_COLS.cautions, joinLines(candidate.cautions));
  put(DUP_COLS.proposedAction, candidate.proposedAction);

  put(DUP_COLS.subjectUrl, candidate.subject.attioUrl);
  put(DUP_COLS.matchUrls, matches.map((m) => m.attioUrl).join('\n'));

  // ⚠ Carried EXPLICITLY rather than read from the triage columns. A
  // duplicate-only row has blank triage columns, so `connection_strength` (X)
  // and the span (M) are empty on exactly the rows the TYPO_DOMAIN card needs
  // them for — that card decides delete-vs-merge on this evidence.
  put(DUP_COLS.firstInteraction, candidate.subject.firstInteractionAt ?? '');
  put(DUP_COLS.lastInteraction, candidate.subject.lastInteractionAt ?? '');
  put(DUP_COLS.strength, candidate.subject.strength ?? '');

  put(DUP_COLS.firstSeen, opts.firstSeen === '' ? opts.today : opts.firstSeen);
  put(DUP_COLS.lastDetected, opts.today);

  return cells;
}

/** What a row already says about its duplicate question. */
export interface ExistingDuplicateState {
  readonly status: string;
  readonly skipUntil: string;
  readonly firstSeen: string;
  readonly cells: readonly unknown[];
  /** True when the row carries no duplicate half at all — a pre-step-3 row. */
  readonly absent: boolean;
}

export function readDuplicateState(row: SheetRow): ExistingDuplicateState {
  const padded = [...row];
  while (padded.length < QUEUE_COLUMNS) padded.push('');
  const status = cell(row, DUP_COLS.status);
  return {
    status,
    skipUntil: cell(row, DUP_COLS.skipUntil),
    firstSeen: cell(row, DUP_COLS.firstSeen),
    cells: padded.slice(DUP_COLS.status, QUEUE_COLUMNS),
    absent: status === '' && cell(row, DUP_COLS.classification) === '',
  };
}

export type DuplicateMergeAction =
  | 'duplicate-new'
  | 'duplicate-refreshed'
  | 'duplicate-preserved-decision'
  | 'duplicate-preserved-skip'
  | 'duplicate-reactivated-skip-expired'
  | 'duplicate-cleared';

export interface DuplicateMergeOutcome {
  readonly action: DuplicateMergeAction;
  readonly cells: readonly unknown[];
  readonly warning: string | null;
}

/**
 * Decide the duplicate half of one row. THE IDEMPOTENCY GATE LIVES HERE.
 *
 * ⚠ A DISMISSAL MUST STICK. A candidate resolved and re-raised unchanged on
 * the next run trains the user to ignore the queue, which costs more than the
 * queue is worth. So any status that is not blank, not `pending` and not an
 * expired `skipped` re-emits the row's OWN duplicate cells, byte for byte —
 * including its `duplicate_last_detected`, so a preserved row is bit-identical
 * across runs and a diff of the tab shows nothing at all.
 */
export function mergeDuplicateCells(
  candidate: DuplicateCandidate | null,
  existing: ExistingDuplicateState | null,
  today: CivilDate,
): DuplicateMergeOutcome {
  const blank = new Array<unknown>(QUEUE_COLUMNS - DUP_COLS.status).fill('');

  // No candidate this run.
  if (!candidate) {
    if (!existing || existing.absent) return { action: 'duplicate-cleared', cells: blank, warning: null };
    const status = existing.status.trim().toLowerCase();
    // A human's answer is kept even after the candidate stops firing — it is
    // the memory that stops the question being re-asked if it fires again.
    if (status !== '' && status !== DUPLICATE_PENDING) {
      return { action: 'duplicate-preserved-decision', cells: existing.cells, warning: null };
    }
    return { action: 'duplicate-cleared', cells: blank, warning: null };
  }

  const status = (existing?.status ?? '').trim().toLowerCase();
  const firstSeen = existing?.firstSeen ?? '';

  if (!existing || existing.absent || status === '' || status === DUPLICATE_PENDING) {
    return {
      action: !existing || existing.absent ? 'duplicate-new' : 'duplicate-refreshed',
      cells: serializeDuplicateCells(candidate, {
        today,
        status: DUPLICATE_PENDING,
        skipUntil: '',
        firstSeen,
      }),
      warning: null,
    };
  }

  if (status === DUPLICATE_SKIPPED) {
    const expired = isCivilDate(existing.skipUntil) && isSameOrBefore(existing.skipUntil, today);
    if (!expired) {
      return { action: 'duplicate-preserved-skip', cells: existing.cells, warning: null };
    }
    return {
      action: 'duplicate-reactivated-skip-expired',
      cells: serializeDuplicateCells(candidate, {
        today,
        status: DUPLICATE_PENDING,
        skipUntil: '',
        firstSeen,
      }),
      warning: null,
    };
  }

  // Every other value — `resolved_merge`, `resolved_delete`, and anything
  // unrecognised — is a decision. Preserved untouched.
  const recognised = status.startsWith('resolved_');
  return {
    action: 'duplicate-preserved-decision',
    cells: existing.cells,
    warning: recognised
      ? null
      : `duplicate_status "${existing.status}" on row ${cellId(existing)} is not recognised — preserved as a decision, not re-raised`,
  };
}

function cellId(existing: ExistingDuplicateState): string {
  return String(existing.cells[0] ?? '(unknown)');
}

/** A default skip window, for whenever Aida starts writing `skipped`. */
export function defaultSkipUntil(today: CivilDate): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + DUPLICATE_SKIP_DAYS);
  return d.toISOString().slice(0, 10);
}

/** Identity columns for a row that exists ONLY to carry a duplicate question. */
export function duplicateOnlyTriageCells(candidate: DuplicateCandidate): unknown[] {
  const cells = new Array<unknown>(DUP_COLS.status).fill('');
  cells[QUEUE_COLS.attioRecordId] = candidate.subject.attioRecordId;
  cells[QUEUE_COLS.name] = candidate.subject.name ?? '';
  cells[QUEUE_COLS.primaryEmail] = candidate.subject.emails[0] ?? '';
  // ⚠ `column`, `status` and `keeper_probability` stay BLANK. This row is not
  // a triage card and must not appear in a triage bucket.
  return cells;
}
