import type { WriteTargets } from '../passes/pass2/write-targets.js';

/**
 * One task from Brain_Complete col Y (Tasks_JSON) — the exact shape PASS 2's
 * TaskSchema produces (src/passes/pass2/enrich-schema.ts). Duplicated here
 * as a plain interface rather than importing z.infer from enrich-schema.ts
 * directly, since that file's exports are Zod schemas built for PASS 2's own
 * LLM-response validation — Part D only needs the resulting shape, not the
 * validator, and importing the validator would pull zod into a place that
 * has no reason to validate anything (this data was already validated once,
 * by PASS 2, before it ever reached Brain_Complete).
 */
export interface StagedTask {
  readonly description: string;
  readonly due_date: string; // '' if none
  readonly priority: string;
}

/**
 * Everything write-row.ts needs for one row, assembled by the caller
 * (load-run-set.ts, not built yet) from a raw Brain_Complete row. Fields
 * split into two groups deliberately: writeTargets/tasks are what actually
 * gets written; the rest (contactId, contactName, direction, subject,
 * runningSummary) are raw passthrough fields Activity_Log's own write needs
 * alongside writeTargets, per spec STEP 4a's column mapping ("C Contact_ID
 * (col B) · E Contact_Name (col C) ... H Direction (col E) · I Subject (col
 * F) · J Body = col K").
 */
export interface WriteRowInput {
  readonly bhcId: string;
  readonly contactName: string;
  readonly direction: string;
  readonly subject: string;
  /**
   * Brain_Complete col H — the thread's most recent email date, mirrored there
   * by PASS 2 from Thread_Staging. Available to write-row.ts but not yet read
   * by it: everything is still stamped with `now`. Threading it through is a
   * deliberately separate step from using it. '' when the sheet cell is blank.
   */
  readonly lastEmailDate: string;
  readonly runningSummary: string;
  readonly writeTargets: WriteTargets;
  readonly tasks: readonly StagedTask[];
  /** Which sheet row in Brain_Complete this came from — for QA re-reads and error messages, never for inferring anything else. */
  readonly brainCompleteRow: number;
}

export interface SecondaryWriteResult {
  readonly bhcId: string;
  readonly activityId: string | null;
  readonly attioRecordId: string | null; // null when this secondary had no attio target, or it was withheld by the identity gate
  readonly ok: boolean;
  readonly warnings: readonly string[];
}

export interface WriteRowResult {
  readonly ok: boolean;
  readonly bhcId: string;
  readonly activityId: string | null;
  /** Human-readable log of what actually happened, same convention as bhc-aida's commit/route.ts `writes` array. */
  readonly writes: readonly string[];
  readonly warnings: readonly string[];
  /** Attio task IDs created in 4d — QA reads these back; if exactly one, it's also written to Activity_Log col T per spec. */
  readonly taskIds: readonly string[];
  /**
   * Explicit, set directly from the identity-gate result rather than left
   * for a caller to infer from parsing `writes`' human-readable strings —
   * confirm.ts (STEP 6) needs exactly this for its "{g} Google · {a} Attio"
   * counts, and string-matching a log line meant for humans is the kind of
   * coupling that silently breaks the moment the wording changes.
   */
  readonly googleWritten: boolean;
  readonly attioWritten: boolean;
  /**
   * Whether writeTargets NAMED each target at all — distinct from whether it
   * was written. Without this, "withheld" is indistinguishable from
   * "FYI-only row with nothing to write": both show googleWritten=false.
   * Added because confirm.ts sees only WriteRowResult, never the input.
   */
  readonly googleTargeted: boolean;
  readonly attioTargeted: boolean;
  /**
   * The identity gate's own warnings, kept separate from the general
   * `warnings` bag so branch.ts can write them to Brain_Complete col U
   * without string-matching a human-readable log — the exact coupling the
   * googleWritten/attioWritten comment below already warns against.
   */
  readonly identityGateWarnings: readonly string[];
  /**
   * True only once 4a's append has actually returned. confirm.ts counted
   * activity entries unconditionally — `1 + secondaries.length` on every
   * resolved row — while google and attio were gated on real booleans, so a
   * run that wrote nothing rendered as "0 Google · 0 Attio · 7 activity
   * entries". Two honest zeros either side of a fabricated seven. Counting
   * outcomes requires a flag set by the outcome.
   */
  readonly activityLogWritten: boolean;
  /**
   * 4f's lighter loop, one entry per secondary in writeTargets.secondary.
   * Per spec: "Secondary QA failure flags that secondary but does NOT block
   * primary V=TRUE" — each secondary's own ok/warnings are tracked
   * independently of the primary's, and independently of each other, for
   * exactly that reason.
   */
  readonly secondaries: readonly SecondaryWriteResult[];
}

/**
 * Top-level entry point types for index.ts. StopReason names the four
 * places Part D can halt before ever reaching branch.ts — three post a
 * specific message (see confirm.ts), one ("empty_run_set") posts nothing
 * at all, per spec: "If empty: stop silently... a prior run already
 * confirmed this digest."
 */
export type StopReason = 'no_run_id' | 'unrecognized_command' | 'empty_run_set' | 'no_valid_item_actions';

export interface PartDOptions {
  readonly commandText: string;
  readonly dryRun: boolean;
}

/**
 * One row's outcome, as it appears in the run artifact.
 *
 * DELIBERATELY SLIM. writeResult and qa are NOT here: they embed subjects,
 * running summaries, draft replies and personal-context extracts, and the
 * report is written to `out/` and uploaded as a CI artifact. Thread content
 * must not land in a 7-day artifact (project instructions §6 — never
 * propagate sensitive data). What is here is what a person debugging a
 * silent run actually needs: which row, whose, what happened, and what the
 * code itself said about why.
 *
 * `warnings` is the load-bearing field. Part D wrote the correct diagnosis —
 * "Master_ID has no entry for  — withholding Google write" — four times a
 * night for a month, and emptyReport() dropped BranchResult.applied
 * wholesale, which was the only thing holding it.
 */
export interface AppliedRowSummary {
  readonly digestPosition: number | null;
  readonly bhcId: string | null;
  readonly outcome: string;
  readonly warnings: readonly string[];
}

export interface PartDReport {
  readonly runId: string | null; // null only when parsing never got far enough to extract one
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean; // a genuine crash (proxy unreachable, etc.), distinct from a normal stop
  readonly abortReason: string | null;
  readonly command: 'PROCEED' | 'CORRECTIONS' | 'RESOLVE' | 'MIXED' | null;
  readonly stopReason: StopReason | null;
  readonly runSetSize: number;
  readonly posted: boolean;
  readonly confirmationMessage: string | null;
  /** Per-row outcomes and warnings. Empty for stop conditions that never reached branch.ts. */
  readonly applied: readonly AppliedRowSummary[];
  /** How many run-set rows took the Write_Targets_JSON identity fallback (load-run-set.ts). */
  readonly rowsUsingWriteTargetIdentity: number;
}
