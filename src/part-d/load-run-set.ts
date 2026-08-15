/**
 * Part D STEP 2 — load the staged rows. Spec: "Read Brain_Complete!A:AB.
 * Select rows where col AB == Run_ID AND col V is blank. Call this the run
 * set. Walk in sheet order; count only rows where col W ≠ NO_ACTION to
 * derive digest positions [1]..[N]. If empty: stop silently."
 *
 * Column indices (0-based) cross-checked against brain-complete-row.ts's
 * own 30-element write array (A-AD) — the same source that builds these
 * rows in the first place, not re-derived or guessed separately:
 *   B=1 bhcId, C=2 contactName, E=4 direction, F=5 subject,
 *   K=10 runningSummary, V=21 blank-flag, W=22 actionRequired,
 *   Y=24 tasksJson, Z=25 writeTargetsJson, AB=27 runId.
 * The spec's own "A:AB" read range covers every one of these (AB is the
 * 28th column, 1-indexed) — reusing RANGES.brainCompleteData (A2:AD) is a
 * couple of columns wider than the spec's own range, not narrower, so
 * nothing needed here is out of range.
 *
 * IDENTITY: col B is PREFERRED, Write_Targets_JSON (col Z) primary.bhc_id is
 * the FALLBACK. Col B is blank on every live Brain_Complete row — Zap C
 * populates Thread_Staging without doing any identity resolution, and PASS 2
 * passed that blank straight through — so from the 2026-07-19 deterministic
 * rebuild until this fix, every row reached the identity gate with an empty
 * key. masterId.byBhcId.get('') returns undefined, both ownership checks took
 * their `if (!entry)` branch, and Part D withheld 100% of primary Google and
 * Attio writes while still reporting success. Secondaries were unaffected
 * because 4f's loop reads secondary.bhc_id straight out of this same parsed
 * JSON — that asymmetry is what made the cause identifiable.
 *
 * The gate was right and is untouched: it was handed an empty key and
 * correctly refused to guess. The fix is to stop handing it one.
 *
 * parseWriteTargets' own shape guard returns null unless primary.bhc_id is
 * truthy, so the fallback can never reintroduce a blank — a row with no
 * usable identity anywhere still arrives with writeTargets === null and takes
 * the existing skipped_no_target path.
 *
 * "Count only rows where col W != NO_ACTION to derive digest positions" —
 * a NO_ACTION row is still part of the run set (RESOLVE/PROCEED still needs
 * to mark it V=TRUE to close it out; STEP 4's own "empty Write_Targets ->
 * mark V=TRUE, nothing to write" covers it), it just never gets a number
 * Bobby could reference in a CORRECTIONS or MIXED command — there's nothing
 * for him to see or react to on a row nothing happened to.
 */

import { RANGES } from '../config/constants.js';
import { cell, type SheetsClient } from '../lib/sheets.js';
import type { WriteTargets } from '../passes/pass2/write-targets.js';
import type { StagedTask } from './types.js';

export interface RunSetRow {
  readonly sheetRow: number; // 1-based physical row in Brain_Complete
  /** 1..N for actionable (non-NO_ACTION) rows in sheet order; null for NO_ACTION rows. */
  readonly digestPosition: number | null;
  /**
   * The contact's identity. Col B PREFERRED, Write_Targets_JSON's
   * primary.bhc_id as fallback — see the module doc comment. Feeds the
   * identity gate, so an empty value here withholds every primary CRM write
   * on the row.
   */
  readonly bhcId: string;
  /** True when col B was blank and identity came from Write_Targets_JSON instead. Reported, never silent. */
  readonly bhcIdFromWriteTargets: boolean;
  readonly contactName: string;
  readonly direction: string;
  readonly subject: string;
  readonly runningSummary: string;
  readonly actionRequired: string;
  /** Parsed from col Z. Null when blank, "{}", or malformed — callers treat null the same as STEP 4's "empty Write_Targets": mark done, nothing to write. */
  readonly writeTargets: WriteTargets | null;
  /** Parsed from col Y. Empty array when blank or malformed — never throws on bad JSON, a malformed Tasks_JSON shouldn't block the row's other writes. */
  readonly tasks: readonly StagedTask[];
}

export interface RunSet {
  readonly runId: string;
  /** Every matching row, sheet order, including NO_ACTION rows. */
  readonly rows: readonly RunSetRow[];
  /** Only actionable rows, keyed by their digest position — the lookup CORRECTIONS/MIXED commands' {n} references resolve against. */
  readonly byDigestPosition: ReadonlyMap<number, RunSetRow>;
  /**
   * How many rows took the Write_Targets_JSON identity fallback. Surfaced at
   * STEP 2 rather than left implicit: today this equals rows.length, because
   * col B is blank on every live row, and a fallback carrying the entire run
   * must be visible rather than quietly papered over.
   */
  readonly rowsUsingWriteTargetIdentity: number;
}

const NO_ACTION = 'NO_ACTION';

function parseWriteTargets(raw: string): WriteTargets | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return null;
  try {
    const parsed = JSON.parse(trimmed) as WriteTargets;
    // Minimal shape guard — a WriteTargets worth acting on has a primary with a bhc_id.
    // Not full schema validation (this was already validated once, by PASS 2,
    // before it ever reached the sheet) — just enough to refuse to hand a
    // caller something write-row.ts would crash trying to destructure.
    if (!parsed || typeof parsed !== 'object' || !parsed.primary || !parsed.primary.bhc_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseTasks(raw: string): readonly StagedTask[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is StagedTask =>
        t !== null && typeof t === 'object' && typeof (t as StagedTask).description === 'string',
    );
  } catch {
    return [];
  }
}

export async function loadRunSet(sheets: SheetsClient, runId: string): Promise<RunSet> {
  const rawRows = await sheets.read(RANGES.brainCompleteData);

  const rows: RunSetRow[] = [];
  const byDigestPosition = new Map<number, RunSetRow>();
  let digestSeq = 0;
  let usingWriteTargetIdentity = 0;

  rawRows.forEach((row, i) => {
    const rowRunId = cell(row, 27); // AB
    if (rowRunId !== runId) return;
    const blankFlag = cell(row, 21); // V
    if (blankFlag !== '') return; // already resolved by a prior run — not part of this run set

    const actionRequired = cell(row, 22); // W
    let digestPosition: number | null = null;
    if (actionRequired !== NO_ACTION) {
      digestSeq += 1;
      digestPosition = digestSeq;
    }

    // Parse col Z BEFORE building the row — it is the identity fallback, not
    // just a payload. Col B stays preferred, so the moment PASS 2 starts
    // populating it (brain-complete-row.ts) it silently becomes the primary
    // path again with no further change here.
    const writeTargets = parseWriteTargets(cell(row, 25)); // Z
    const columnBhcId = cell(row, 1); // B
    const fallbackBhcId = writeTargets?.primary.bhc_id ?? '';
    const bhcId = columnBhcId || fallbackBhcId;
    const bhcIdFromWriteTargets = columnBhcId === '' && fallbackBhcId !== '';
    if (bhcIdFromWriteTargets) usingWriteTargetIdentity += 1;

    const runSetRow: RunSetRow = {
      sheetRow: 2 + i, // Brain_Complete data starts at row 2
      digestPosition,
      bhcId,
      bhcIdFromWriteTargets,
      contactName: cell(row, 2), // C
      direction: cell(row, 4), // E
      subject: cell(row, 5), // F
      runningSummary: cell(row, 10), // K
      actionRequired,
      writeTargets,
      tasks: parseTasks(cell(row, 24)), // Y
    };

    rows.push(runSetRow);
    if (digestPosition !== null) byDigestPosition.set(digestPosition, runSetRow);
  });

  return { runId, rows, byDigestPosition, rowsUsingWriteTargetIdentity: usingWriteTargetIdentity };
}
