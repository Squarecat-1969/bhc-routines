/**
 * ⚠ STOP RETRYING AN ENTRY THAT KEEPS FAILING — AND SAY SO OUT LOUD.
 *
 * The watermark is derived from the index: an entry with no reference is
 * unindexed, so a failed entry is indistinguishable from a new one and is
 * retried at full cost on every run, forever. §092 and §096 failed three
 * consecutive runs and §102 two, each spending an Anthropic call to relearn
 * the same rejection, while the run reported GREEN with a warning that
 * scrolled past. That is the exact shape this routine exists to prevent: a
 * check that looks healthy while making no progress.
 *
 * ⚠ AND A BLOCKED ENTRY MUST NEVER BECOME INVISIBLE. An entry that silently
 * drops out of the population would make the backlog look closed — the same
 * defect in a new costume. Blocked entries are reported BY NAME on every run,
 * with their failure count and last error, whether or not anything else
 * happened.
 */

import { cell, type SheetRow } from '../../lib/sheets.js';

export const STATE_TAB = 'Index_Maintenance_State';
export const STATE_TAB_NAME = STATE_TAB;
export const STATE_RANGES = {
  header: `${STATE_TAB}!A1:G1`,
  data: `${STATE_TAB}!A2:G`,
} as const;

export const STATE_HEADER = [
  'locator',
  'consecutive_failures',
  'blocked',
  'last_error',
  'last_attempt_date',
  'prompt_version',
  'vocabulary_size',
] as const;

export const STATE_COLS = {
  locator: 0,
  consecutiveFailures: 1,
  blocked: 2,
  lastError: 3,
  lastAttemptDate: 4,
  promptVersion: 5,
  vocabularySize: 6,
} as const;

export const STATE_COLUMNS = STATE_HEADER.length;

/**
 * ⚠ THREE, AND THE NUMBER IS EVIDENCE-LED.
 *
 * Two consecutive failures can still be two transient faults — a 429, a
 * timeout, a truncated response. Three identical rejections on the same entry
 * is a pattern, and §092 and §096 reaching exactly three is what made this
 * visible at all.
 *
 * The asymmetry sets it: one extra attempt costs one LLM call, while blocking
 * a run too early costs an entry that would have indexed and is now silently
 * absent from the index — which is the failure mode this whole routine exists
 * to prevent. So the threshold sits one attempt past "could plausibly be
 * transient", not at it.
 */
export const BLOCK_AFTER = 3;

/**
 * ⚠ BUMP THIS WHEN THE PROMPT CHANGES, and every blocked entry is reconsidered
 * exactly once, automatically.
 *
 * A block records a conclusion reached by a VERSION OF THE PROMPT, not a fact
 * about the entry. §092, §096 and §102 were blocked because nothing told the
 * model there was a twelve-term cap; under the prompt that does, all three
 * index. Without this field they would have stayed blocked forever under a
 * prompt that never judged them, and someone would have had to remember to
 * clear the tab by hand. Same lesson as the re-resolution pass's derivation
 * version.
 */
export const PROMPT_VERSION = '2026-09-08-prioritise-12';

export interface EntryFailureState {
  readonly locator: string;
  readonly consecutiveFailures: number;
  readonly blocked: boolean;
  readonly lastError: string;
  readonly lastAttemptDate: string;
  readonly promptVersion: string;
  readonly vocabularySize: number;
}

export function parseFailureRow(row: SheetRow): EntryFailureState | null {
  const locator = cell(row, STATE_COLS.locator);
  if (locator === '') return null;
  return {
    locator,
    consecutiveFailures: Number(cell(row, STATE_COLS.consecutiveFailures)) || 0,
    blocked: cell(row, STATE_COLS.blocked).toUpperCase() === 'TRUE',
    lastError: cell(row, STATE_COLS.lastError),
    lastAttemptDate: cell(row, STATE_COLS.lastAttemptDate),
    promptVersion: cell(row, STATE_COLS.promptVersion),
    vocabularySize: Number(cell(row, STATE_COLS.vocabularySize)) || 0,
  };
}

export type BlockDecision =
  | { readonly blocked: true; readonly failures: number; readonly lastError: string }
  | { readonly blocked: false; readonly reason: 'no-state' | 'not-yet' | 'prompt-changed' | 'vocabulary-changed' };

/**
 * Is this entry blocked on this run?
 *
 * ⚠ THE RESET CONDITIONS ARE CHECKED FIRST, DELIBERATELY. A block is only
 * evidence while the thing that produced it is unchanged. A new prompt or a
 * grown vocabulary are both genuine reasons the outcome could differ, and
 * honouring a stale block over them is how an entry stays permanently absent
 * after the bug that blocked it was fixed.
 */
export function blockDecision(
  state: EntryFailureState | undefined,
  promptVersion: string,
  vocabularySize: number,
): BlockDecision {
  if (!state) return { blocked: false, reason: 'no-state' };
  if (state.promptVersion !== promptVersion) return { blocked: false, reason: 'prompt-changed' };
  if (state.vocabularySize !== vocabularySize) return { blocked: false, reason: 'vocabulary-changed' };
  if (state.blocked) return { blocked: true, failures: state.consecutiveFailures, lastError: state.lastError };
  return { blocked: false, reason: 'not-yet' };
}

/** The state a run records for one entry. Success clears the count; failure advances it. */
export function nextState(input: {
  readonly locator: string;
  readonly prior: EntryFailureState | undefined;
  readonly succeeded: boolean;
  readonly error: string | null;
  readonly today: string;
  readonly promptVersion: string;
  readonly vocabularySize: number;
}): EntryFailureState {
  // ⚠ CONSECUTIVE, not cumulative — a success resets the count to zero. An
  // entry that failed twice and then indexed is not two-thirds blocked.
  const priorCount =
    input.prior && input.prior.promptVersion === input.promptVersion ? input.prior.consecutiveFailures : 0;
  const failures = input.succeeded ? 0 : priorCount + 1;
  return {
    locator: input.locator,
    consecutiveFailures: failures,
    blocked: failures >= BLOCK_AFTER,
    lastError: input.succeeded ? '' : (input.error ?? 'unknown'),
    lastAttemptDate: input.today,
    promptVersion: input.promptVersion,
    vocabularySize: input.vocabularySize,
  };
}

export function serializeFailureRow(s: EntryFailureState): unknown[] {
  const cells = new Array<unknown>(STATE_COLUMNS).fill('');
  cells[STATE_COLS.locator] = s.locator;
  cells[STATE_COLS.consecutiveFailures] = s.consecutiveFailures;
  cells[STATE_COLS.blocked] = s.blocked ? 'TRUE' : 'FALSE';
  cells[STATE_COLS.lastError] = s.lastError.slice(0, 300);
  cells[STATE_COLS.lastAttemptDate] = s.lastAttemptDate;
  cells[STATE_COLS.promptVersion] = s.promptVersion;
  cells[STATE_COLS.vocabularySize] = s.vocabularySize;
  return cells;
}
