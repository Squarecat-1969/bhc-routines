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

export interface WriteRowResult {
  readonly ok: boolean;
  readonly bhcId: string;
  readonly activityId: string | null;
  /** Human-readable log of what actually happened, same convention as bhc-aida's commit/route.ts `writes` array. */
  readonly writes: readonly string[];
  readonly warnings: readonly string[];
  /** Attio task IDs created in 4d — QA reads these back; if exactly one, it's also written to Activity_Log col T per spec. */
  readonly taskIds: readonly string[];
}
