/** Constants for the identity re-resolution pass. See docs/re-resolution-spec.md. */

export function makeReresolutionRunId(now: Date = new Date()): string {
  return `RE-RESOLVE-${now.getTime()}`;
}

/**
 * ⚠ STATE LIVES IN ITS OWN TAB, NOT IN A NEW Brain_Complete COLUMN.
 *
 * `Brain_Complete` is A:AD and five passes read it POSITIONALLY. PASS 1 blanks
 * A:AD during compaction and PASS 2 appends a fixed-width row; widening it
 * touches all of that. A separate tab keyed on `thread_id` — stable, unique,
 * column A — changes nothing any existing pass depends on. Same precedent as
 * `Contacts_Triage_Queue`.
 *
 * ⚠ The tab must exist before a live run: the Sheets proxy can read, update
 * and append, but it cannot create a tab.
 */
export const STATE_TAB = 'Reresolution_State';

export const STATE_RANGES = {
  header: `${STATE_TAB}!A1:H1`,
  data: `${STATE_TAB}!A2:H`,
  append: `${STATE_TAB}!A2:H`,
} as const;

export const STATE_HEADER = [
  'thread_id',
  'brain_complete_row',
  'last_class',
  'terminal',
  /**
   * ⚠ WHY A TERMINAL MARKER CARRIES A VERSION.
   *
   * A terminal marker records a CONCLUSION REACHED BY A VERSION OF THE CODE,
   * not a fact about the world. `NO_PRIMARY_EMAIL` means "this build could not
   * derive an external party" — and that build changed on 2026-09-07, when the
   * `stripOwned` fix in participants.ts stopped a joined recipient string from
   * smuggling an internal address through as a participant. Rows marked
   * terminal by the older derivation may be resolvable under the newer one.
   *
   * So the marker is only honoured while the version that set it still
   * matches. Bump DERIVATION_VERSION and every terminal marker is re-derived
   * exactly once, automatically, with no manual clearing step to forget.
   */
  'derivation_version',
  /**
   * The resolver corpus at the last attempt. A TIMESTAMP says when you last
   * tried; a FINGERPRINT says whether anything could have changed since.
   */
  'corpus_fingerprint',
  'last_attempt_date',
  'notes',
] as const;

export const STATE_COLS = {
  threadId: 0,
  brainCompleteRow: 1,
  lastClass: 2,
  terminal: 3,
  derivationVersion: 4,
  corpusFingerprint: 5,
  lastAttemptDate: 6,
  notes: 7,
} as const;

export const STATE_COLUMNS = STATE_HEADER.length;

/**
 * ⚠ BUMP THIS WHENEVER PRIMARY-EMAIL DERIVATION CHANGES.
 *
 * Set to the date of the last change to `identifyPrimaryAndSecondary` /
 * `stripOwned` — the `stripOwned` spread fix, participants.ts:72, which is the
 * change that makes this versioning necessary rather than theoretical.
 */
export const DERIVATION_VERSION = '2026-09-07';

/** The four outcomes of the cascade, as this pass classifies them. */
export const CLASSES = ['RESOLVABLE', 'NEW_CANDIDATE', 'UNRESOLVED', 'NO_PRIMARY_EMAIL'] as const;
export type ResolutionClass = (typeof CLASSES)[number];

/**
 * The only class that can be closed permanently. There is no email to resolve,
 * and no future state of Attio or Contacts changes that — the condition is
 * structural, which is what makes a terminal marker safe here and nowhere else.
 */
export const TERMINAL_CLASS: ResolutionClass = 'NO_PRIMARY_EMAIL';

/** One `searchPeopleByEmail` per candidate row. A cost backstop, not a limit on the corpus. */
export const MAX_RESOLVE_ATTEMPTS_PER_RUN = 400;
export const RESOLVE_CONCURRENCY = 4;
export const RESOLVE_WAVE_PAUSE_MS = 250;

/**
 * ⚠ SHEETS QUOTA IS 60 READS AND 60 WRITES PER MINUTE PER USER, and the first
 * live attempt died on a 429 partway through the write loop. Pause briefly
 * every few writes so a 34-row run cannot exhaust the write quota either.
 * Measured cause, not a defensive guess.
 */
export const WRITE_PAUSE_EVERY = 10;
export const WRITE_PAUSE_MS = 1500;
