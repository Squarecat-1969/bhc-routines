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
}
