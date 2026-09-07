/**
 * The retry gate. Pure — no I/O.
 *
 * ⚠ THIS IS THE WHOLE DESIGN. Get it wrong and the pass is a nightly 264-call
 * no-op that reports success — the same failure shape as an LLM cap that
 * spends without progress and comes back green.
 *
 * 289 of the 347 blank rows (measured 2026-09-07) cannot resolve tonight by any
 * mechanism this pass controls: 83 have no derivable external party at all, and
 * 206 have no Attio record to find. Re-judging them every run buys nothing.
 */

import {
  DERIVATION_VERSION,
  STATE_COLS,
  STATE_COLUMNS,
  TERMINAL_CLASS,
  type ResolutionClass,
} from './constants.js';
import { cell, type SheetRow } from '../../lib/sheets.js';

export interface RowState {
  readonly threadId: string;
  readonly brainCompleteRow: number;
  readonly lastClass: string;
  readonly terminal: boolean;
  readonly derivationVersion: string;
  readonly corpusFingerprint: string;
  readonly lastAttemptDate: string;
  readonly notes: string;
  /** The row's own cells, so an untouched row can be re-emitted byte-identical. */
  readonly cells: readonly unknown[];
}

export function parseStateRow(row: SheetRow): RowState | null {
  const threadId = cell(row, STATE_COLS.threadId);
  if (threadId === '') return null;
  const padded = [...row];
  while (padded.length < STATE_COLUMNS) padded.push('');
  return {
    threadId,
    brainCompleteRow: Number(cell(row, STATE_COLS.brainCompleteRow)) || 0,
    lastClass: cell(row, STATE_COLS.lastClass),
    terminal: cell(row, STATE_COLS.terminal).toUpperCase() === 'TRUE',
    derivationVersion: cell(row, STATE_COLS.derivationVersion),
    corpusFingerprint: cell(row, STATE_COLS.corpusFingerprint),
    lastAttemptDate: cell(row, STATE_COLS.lastAttemptDate),
    notes: cell(row, STATE_COLS.notes),
    cells: padded.slice(0, STATE_COLUMNS),
  };
}

/**
 * The resolver's corpus, reduced to a value that changes exactly when a
 * previously-unresolvable row could become resolvable.
 *
 * ⚠ A FINGERPRINT, NOT A TIMESTAMP. A timestamp records when the last attempt
 * happened; it says nothing about whether anything has changed since, so a
 * time-based retry re-judges 289 dead rows on a schedule. The two inputs below
 * are the only two the cascade consults, and both are already loaded by the
 * run — so this costs nothing to compute.
 *
 * A NEW_CANDIDATE row resolves only after someone mints or bridges its contact,
 * and either act moves `bridgedAttioCount`. That is the signal.
 */
export function corpusFingerprint(input: {
  readonly contactsEmailCount: number;
  readonly bridgedAttioCount: number;
}): string {
  return `c${input.contactsEmailCount}:a${input.bridgedAttioCount}`;
}

export type SkipReason =
  | 'terminal'
  | 'corpus-unchanged';

export type RetryDecision =
  | { readonly attempt: true; readonly reason: 'never-attempted' | 'corpus-moved' | 'derivation-changed' }
  | { readonly attempt: false; readonly reason: SkipReason };

/**
 * Should this row be re-resolved on this run?
 *
 * ⚠ THE DERIVATION-VERSION CHECK COMES BEFORE THE TERMINAL CHECK, DELIBERATELY.
 * A terminal marker is a conclusion reached by a version of the code, not a
 * fact about the world — so a marker set by an older derivation is not
 * evidence about this one. Bumping DERIVATION_VERSION re-opens every terminal
 * row exactly once, with no manual clearing step for anyone to forget.
 */
export function shouldAttempt(state: RowState | undefined, fingerprint: string): RetryDecision {
  if (!state) return { attempt: true, reason: 'never-attempted' };

  if (state.derivationVersion !== DERIVATION_VERSION) {
    return { attempt: true, reason: 'derivation-changed' };
  }

  if (state.terminal) return { attempt: false, reason: 'terminal' };

  if (state.corpusFingerprint !== fingerprint) return { attempt: true, reason: 'corpus-moved' };

  // Same corpus, same derivation, not terminal — nothing can have changed.
  return { attempt: false, reason: 'corpus-unchanged' };
}

/** Only the structurally-unresolvable class is ever marked terminal. */
export function isTerminalClass(cls: ResolutionClass): boolean {
  return cls === TERMINAL_CLASS;
}

export function serializeStateRow(input: {
  readonly threadId: string;
  readonly brainCompleteRow: number;
  readonly cls: ResolutionClass;
  readonly fingerprint: string;
  readonly today: string;
  readonly notes: string;
}): unknown[] {
  const cells = new Array<unknown>(STATE_COLUMNS).fill('');
  cells[STATE_COLS.threadId] = input.threadId;
  cells[STATE_COLS.brainCompleteRow] = input.brainCompleteRow;
  cells[STATE_COLS.lastClass] = input.cls;
  cells[STATE_COLS.terminal] = isTerminalClass(input.cls) ? 'TRUE' : 'FALSE';
  cells[STATE_COLS.derivationVersion] = DERIVATION_VERSION;
  cells[STATE_COLS.corpusFingerprint] = input.fingerprint;
  cells[STATE_COLS.lastAttemptDate] = input.today;
  cells[STATE_COLS.notes] = input.notes;
  return cells;
}
