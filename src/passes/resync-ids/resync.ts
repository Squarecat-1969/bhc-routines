/**
 * Resync IDs — re-derive Master_ID.Google_Row from Contacts col A.
 *
 * WHY FULL RE-DERIVATION, NEVER SHIFT-TRACKING: a stored row number is a
 * cached pointer into a sheet humans edit by hand. Deleting one Contacts row
 * silently invalidates every pointer below it, and nothing in the system
 * notices — Master_ID keeps claiming a row that now belongs to someone else.
 * Tracking deltas would mean trusting that we saw every edit; re-deriving from
 * the identity column means the answer is correct regardless of what happened
 * in between. Confirmed real: BHC-02476/77/78 were corrupted this way and
 * fixed by hand on 2026-08-17.
 *
 * Pure — no I/O, no clock. The caller fetches, decides, and writes.
 */

import type { MasterIdRowLite, ResyncPlan, ResyncWriteResult, RowCorrection, Unresolvable } from './types.js';

/** Location values whose Google_Row is meaningful. */
const GOOGLE_LOCATIONS = new Set(['GOOGLE', 'BOTH']);

/**
 * Retired identities. Skipped on the Location field ALONE — never inferred
 * from blank pointers. A SUPERSEDED row's blank Google_Row is correct by
 * design; a damaged row's blank Google_Row is a defect that must stay
 * visible. Inferring "retired" from "blank" would silently swallow the
 * second case, which is exactly the bug this rule exists to prevent
 * (Master_ID row 962 / BHC-00920 is a real damaged row).
 */
const SUPERSEDED = 'SUPERSEDED';

/**
 * Build the Contact_ID -> row-number index from ONE read of Contacts col A.
 *
 * `firstDataRow` is the sheet row the first array element corresponds to —
 * 3 for the live tab, because row 1 is the header and row 2 is the
 * ARRAYFORMULA spill.
 *
 * A Contact_ID appearing at more than one row is recorded as ambiguous, not
 * resolved by first-wins: picking one would hand out a confident pointer to
 * a contact whose identity is genuinely in question.
 */
export function buildContactsIndex(
  idColumn: readonly (readonly unknown[])[],
  firstDataRow = 3,
): { index: ReadonlyMap<string, number>; duplicates: ReadonlySet<string> } {
  const index = new Map<string, number>();
  const duplicates = new Set<string>();

  idColumn.forEach((row, i) => {
    const id = String(row?.[0] ?? '').trim();
    if (id === '') return; // blank cell — not a contact
    if (index.has(id)) {
      duplicates.add(id);
      return;
    }
    index.set(id, firstDataRow + i);
  });

  return { index, duplicates };
}

export function computeResync(
  masterRows: readonly MasterIdRowLite[],
  contacts: { index: ReadonlyMap<string, number>; duplicates: ReadonlySet<string> },
): ResyncPlan {
  const corrections: RowCorrection[] = [];
  const unresolvable: Unresolvable[] = [];
  let alreadyCorrect = 0;
  let skippedSuperseded = 0;
  let skippedNotGoogle = 0;
  let skippedGapRows = 0;
  let checked = 0;

  for (const row of masterRows) {
    if (row.bhcId === '') { skippedGapRows += 1; continue; }
    if (row.location === SUPERSEDED) { skippedSuperseded += 1; continue; }
    if (!GOOGLE_LOCATIONS.has(row.location)) { skippedNotGoogle += 1; continue; }

    checked += 1;

    if (contacts.duplicates.has(row.bhcId)) {
      unresolvable.push({
        bhcId: row.bhcId, masterRow: row.masterRow, storedGoogleRow: row.storedGoogleRow,
        reason: 'duplicate_in_contacts',
        detail: `${row.bhcId} appears on more than one Contacts row — refusing to choose one`,
      });
      continue;
    }

    const actual = contacts.index.get(row.bhcId);
    if (actual === undefined) {
      // NOT this routine's problem to solve. A contact missing from Contacts
      // entirely is a Reconciler finding; guessing a row here would invent a
      // pointer to a contact that isn't there.
      unresolvable.push({
        bhcId: row.bhcId, masterRow: row.masterRow, storedGoogleRow: row.storedGoogleRow,
        reason: 'not_in_contacts',
        detail: `${row.bhcId} is not in Contacts col A — left untouched for Reconciler to flag`,
      });
      continue;
    }

    if (row.storedGoogleRow === actual) { alreadyCorrect += 1; continue; }

    corrections.push({
      bhcId: row.bhcId, masterRow: row.masterRow,
      oldRow: row.storedGoogleRow, newRow: actual,
    });
  }

  return {
    checked, corrections, alreadyCorrect, unresolvable,
    skippedSuperseded, skippedNotGoogle, skippedGapRows,
  };
}

/** Terse Slack body, Reconciler's own register: counts first, then specifics. */
export function formatSlackMessage(plan: ResyncPlan, opts: { dryRun: boolean; runId: string }): string {
  const head = opts.dryRun
    ? `🔁 Resync IDs (DRY RUN — nothing written) — ${opts.runId}`
    : `🔁 Resync IDs — ${opts.runId}`;

  const lines = [
    head,
    `${plan.checked} row(s) checked · ${plan.corrections.length} correction(s) · ${plan.alreadyCorrect} already correct · ${plan.unresolvable.length} unresolvable`,
  ];

  if (plan.corrections.length > 0) {
    lines.push('Corrections:');
    for (const c of plan.corrections) {
      lines.push(`• ${c.bhcId} — Google_Row ${c.oldRow ?? '(blank)'} → ${c.newRow}`);
    }
  }
  if (plan.unresolvable.length > 0) {
    lines.push(`Unresolvable (left untouched, Reconciler's to flag):`);
    for (const u of plan.unresolvable.slice(0, 10)) {
      lines.push(`• ${u.bhcId} — ${u.reason === 'not_in_contacts' ? 'not in Contacts' : 'duplicate in Contacts'}`);
    }
    if (plan.unresolvable.length > 10) lines.push(`• …and ${plan.unresolvable.length - 10} more`);
  }
  if (plan.corrections.length === 0 && plan.unresolvable.length === 0) {
    lines.push('All Google_Row pointers already correct.');
  }
  return lines.join('\n');
}

/**
 * How many corrections were issued but did NOT verify on read-back.
 *
 * This — not the warnings array — is what decides the process exit code, and
 * the distinction is load-bearing now that Reconciler chains off this job's
 * conclusion via workflow_run.
 *
 * Exiting non-zero on ANY warning meant a purely advisory finding (a duplicate
 * Contact_ID, which this routine deliberately leaves untouched for Reconciler
 * to flag) would fail the job, and a failed job silently cancels the chain:
 * `conclusion != 'success'`, no Reconciler run, no error anywhere pointing at
 * why. A write that did not land is a real failure and must still fail the job;
 * an advisory note about data this routine intentionally declined to touch is
 * not, and must not.
 */
export function failedWriteCount(writes: readonly ResyncWriteResult[]): number {
  return writes.filter((w) => w.outcome === 'WRITE_FAILED' || w.outcome === 'MISMATCH').length;
}

/**
 * Corrections that were ISSUED but could not be confirmed — the read-back
 * itself failed.
 *
 * Deliberately NOT folded into failedWriteCount. These are not known failures:
 * on 2026-08-20 three of them had landed perfectly well and only their
 * verification read hit the quota. Counting them as failures told Bobby three
 * records were unwritten when they were fine, and buried the one that really
 * wasn't.
 *
 * They still stop the job — an unconfirmed write is not a proven one, and
 * Reconciler must not audit on top of it — but they are counted, logged and
 * reported as their own thing.
 */
export function inconclusiveWriteCount(writes: readonly ResyncWriteResult[]): number {
  return writes.filter((w) => w.outcome === 'VERIFY_INCONCLUSIVE').length;
}
