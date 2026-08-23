/**
 * Reconciler Fix - Slack report shaping. Pure: no I/O, no credentials.
 *
 * Mirrors passes/reconciler/report.ts, which does the same job for the audit
 * side. Everything here is a function of the ReconcilerFixReport the run
 * already produced - nothing re-reads a sheet, nothing writes.
 *
 * THE ONE HARD RULE THIS FILE EXISTS TO ENFORCE: it must never be ambiguous
 * whether something went unfixed because Fix TRIED and could not, or because
 * Fix was never going to try. Those are four distinct buckets, and they are
 * kept distinct all the way to the message:
 *
 *   fixed        - repaired this run.
 *   needs manual - Fix attempted it and stopped, deliberately. A human decides.
 *   held         - Fix declined to attempt it because ownership is unresolved
 *                  (A1 candidates on an S4-contested pointer, I1 candidates on
 *                  an S1-disputed BHC_ID). NOT a failure; the exclusions exist
 *                  because acting anyway corrupted records - see PR #19, #20.
 *   out of scope - a HIGH/MEDIUM Reconciler finding whose code Fix has no
 *                  repair pass for at all. Never attempted, never will be.
 *
 * COUNTS COME FROM `counts`, NEVER RECOMPUTED. Where a category's `counts`
 * omits an outcome (A3's skipped_superseded, S4/S1's nothing_to_do, I1's
 * already_correct), that one bucket is derived from the result rows, because
 * without it `considered` does not reconcile against what is displayed. The
 * shipped `counts` stay authoritative for fixed/needsManual so this message can
 * never disagree with the JSON artifact from the same run.
 *
 * KNOWN ASYMMETRY, deliberately preserved rather than smoothed over: A1 and I1
 * fold write_failed / qa_failed / lookup_failed INTO needsManual (that is how
 * repairA1 and repairI1 already define it), while A3 reports write_failed and
 * hard_stop separately, so those surface on the failures segment instead. The
 * alternative - recomputing A1/I1's buckets here to match A3 - would make this
 * message disagree with the artifact's own counts, which is worse than an
 * asymmetry that is written down.
 *
 * UNITS DIFFER BY CATEGORY AND THE MESSAGE SAYS SO. S1 and S4 work in GROUPS
 * (a duplicate BHC_ID, a contested pointer); A1, A3 and I1 work in individual
 * candidate rows. S1's orphansFlagged and both routines' hardStops/writeFailures
 * count WRITES, not groups - so they are never mixed into the group buckets, and
 * write-level failures are reported on their own footer line.
 *
 * A3's failures appear TWICE ON PURPOSE: on A3's own line, where they are
 * needed for `considered` to reconcile, and again in the footer's attributed
 * total, which exists to answer "did anything fail anywhere, and in which
 * pass" without the reader having to scan every category line. The two views
 * answer different questions; omitting A3 from the footer would make a footer
 * reading "no failures" wrong.
 */

import { ISSUE_META, type IssueCode, type Severity } from '../reconciler/types.js';
import type { ReconcilerFixReport } from './index.js';

/** The five codes Reconciler Fix has a repair pass for. */
export const FIX_CODES = ['S1', 'A1', 'A3', 'S4', 'I1'] as const;
export type FixCode = (typeof FIX_CODES)[number];

const OUT_OF_SCOPE_SEVERITIES: readonly Severity[] = ['HIGH', 'MEDIUM'];

/**
 * HIGH/MEDIUM issue codes outside Fix's five, derived from ISSUE_META rather
 * than hardcoded - if a severity is retuned there, or a code is added, this
 * follows automatically instead of silently going stale. Resolves today to
 * S2, S3, S5, G1, G3, A5. LOW/INFO codes (G2, A2, A4) are deliberately not
 * listed: they are not what a report about unresolved risk is for.
 */
export function outOfScopeCodes(): readonly IssueCode[] {
  const fix = new Set<string>(FIX_CODES);
  return (Object.keys(ISSUE_META) as IssueCode[])
    .filter((c) => !fix.has(c))
    .filter((c) => OUT_OF_SCOPE_SEVERITIES.includes(ISSUE_META[c].severity));
}

export interface CategorySummary {
  readonly code: FixCode;
  readonly label: string;
  /** What `considered` counts: whole groups (S1, S4) or individual rows. */
  readonly unit: 'group' | 'candidate';
  readonly considered: number;
  /** null for S1 - it is flag-only by design and has no "fixed" outcome. */
  readonly fixed: number | null;
  readonly needsManual: number;
  /** Correct as-is: already_correct, skipped_superseded, nothing_to_do. */
  readonly noAction: number;
  /** Failures counted in the SAME unit as `considered` (A3 only today). */
  readonly failed: number;
}

const LABEL: Readonly<Record<FixCode, string>> = {
  S1: 'Duplicate BHC_ID',
  A1: 'Attio ID mismatch',
  A3: 'Attio record not found',
  S4: 'Duplicate Attio pointer',
  I1: 'Identity field drift',
};

/**
 * Per-category buckets, built so `considered` ALWAYS equals
 * fixed + needsManual + noAction + failed. That invariant is what makes the
 * message trustworthy at a glance, and it is asserted directly in the tests.
 */
export function summarize(report: ReconcilerFixReport): readonly CategorySummary[] {
  const { s1, a1, a3, s4, i1 } = report;

  // S1 is flag-only: its groups are either flagged for a human or were nothing
  // to do. `orphansFlagged` is a ROW count and is reported separately, never as
  // a group bucket.
  const s1Flagged = s1.groups.filter((g) => g.outcome === 'flagged').length;
  const s1Nothing = s1.groups.filter((g) => g.outcome === 'nothing_to_do').length;

  const a3Superseded = a3.rows.filter((r) => r.outcome === 'skipped_superseded').length;
  const s4Nothing = s4.groups.filter((g) => g.outcome === 'nothing_to_do').length;
  const i1AlreadyCorrect = i1.rows.filter((r) => r.outcome === 'already_correct').length;

  return [
    {
      code: 'S1', label: LABEL.S1, unit: 'group',
      considered: s1.counts.groups,
      fixed: null,
      needsManual: s1Flagged,
      noAction: s1Nothing,
      failed: 0, // S1's hardStops/writeFailures are write-unit -> footer
    },
    {
      code: 'A1', label: LABEL.A1, unit: 'candidate',
      considered: a1.counts.considered,
      fixed: a1.counts.fixed,
      needsManual: a1.counts.needsManual,
      noAction: 0, // A1 has no already_correct outcome
      failed: 0, // folded into needsManual by repairA1 - see header
    },
    {
      code: 'A3', label: LABEL.A3, unit: 'candidate',
      considered: a3.counts.considered,
      fixed: a3.counts.repointed + a3.counts.setGoogleOnly,
      needsManual: a3.counts.ambiguous + a3.counts.lookupFailed,
      noAction: a3Superseded,
      failed: a3.counts.writeFailed + a3.counts.hardStops,
    },
    {
      code: 'S4', label: LABEL.S4, unit: 'group',
      considered: s4.counts.groups,
      fixed: s4.counts.repaired,
      needsManual: s4.counts.needsManual + s4.counts.lookupFailed,
      noAction: s4Nothing,
      failed: 0, // S4's hardStops are write-unit -> footer
    },
    {
      code: 'I1', label: LABEL.I1, unit: 'candidate',
      considered: i1.counts.considered,
      fixed: i1.counts.fixed,
      needsManual: i1.counts.needsManual,
      noAction: i1AlreadyCorrect,
      failed: 0, // folded into needsManual by repairI1 - see header
    },
  ];
}

export interface WriteFailureBreakdown {
  readonly total: number;
  /** Only categories that actually contributed, in the table's own order. */
  readonly byCategory: readonly { readonly code: FixCode; readonly n: number }[];
}

/**
 * Failures, ATTRIBUTED TO THE PASS THAT PRODUCED THEM. A bare total tells the
 * reader something broke but not where, which means opening the JSON artifact
 * just to learn which pass to look at - so the breakdown is always named.
 *
 * The three contributors count slightly different things, and that is fine for
 * this purpose: S1 and S4 count individual failed WRITES (hard stops, readback
 * mismatches), while A3 counts candidate ROWS whose repair ended in
 * write_failed or hard_stop. Both answer the only question this line exists to
 * answer - which pass to go read. The per-category lines above remain the
 * place where units are stated exactly, and A3's row-unit failures also stay
 * on A3's own line so its `considered` still reconciles.
 */
export function writeFailures(report: ReconcilerFixReport): WriteFailureBreakdown {
  const byCategory = [
    { code: 'S1' as const, n: report.s1.counts.hardStops + report.s1.counts.writeFailures },
    { code: 'A3' as const, n: report.a3.counts.writeFailed + report.a3.counts.hardStops },
    { code: 'S4' as const, n: report.s4.counts.hardStops },
  ].filter((c) => c.n > 0);
  return { total: byCategory.reduce((t, c) => t + c.n, 0), byCategory };
}

function categoryLine(s: CategorySummary): string {
  const unit = s.unit === 'group' ? 'group(s)' : 'considered';
  const parts = [`${s.considered} ${unit}`];
  // S1 says "flag-only" out loud rather than printing "0 fixed", which would
  // read as an attempt that failed.
  if (s.fixed === null) parts.push('flag-only');
  else parts.push(`${s.fixed} fixed`);
  if (s.needsManual > 0) parts.push(`${s.needsManual} need manual`);
  if (s.noAction > 0) parts.push(`${s.noAction} no action needed`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  return `${s.code} ${s.label}: ${parts.join(' · ')}`;
}

export function buildFixSlackMessage(report: ReconcilerFixReport): string {
  const summaries = summarize(report);
  const totalConsidered = summaries.reduce((n, s) => n + s.considered, 0);
  const totalFixed = summaries.reduce((n, s) => n + (s.fixed ?? 0), 0);
  const totalNeedsManual = summaries.reduce((n, s) => n + s.needsManual, 0);
  const held = report.excludedFromA1.length + report.excludedFromI1.length;
  const outOfScope = Object.entries(report.outOfScope).filter(([, n]) => n > 0);
  const source = report.sourceRunId ?? '(no source run found)';

  // Nothing in scope AND nothing outside it - one line, same as Reconciler's
  // all-clean case. A five-line table of zeroes is noise.
  if (totalConsidered === 0 && held === 0 && outOfScope.length === 0) {
    return `✓ Reconciler Fix ${report.fixRunId} - source audit ${source} had no repairable findings. Nothing to do.`;
  }

  const lines = [
    `🔧 Reconciler Fix - ${report.fixRunId}`,
    `Source audit ${source} · ${totalConsidered} candidate(s) in scope`,
    `✅ ${totalFixed} fixed · 🔸 ${totalNeedsManual} still need you`,
    '',
    ...summaries.filter((s) => s.considered > 0).map(categoryLine),
  ];

  if (report.s1.counts.orphansFlagged > 0) {
    lines.push(`  -> ${report.s1.counts.orphansFlagged} duplicate row(s) flagged in Master_ID for a human to settle`);
  }

  // The held bucket. Named as a deliberate hold, never as a failure - these
  // are the exclusions PR #19 and #20 exist because of.
  if (held > 0) {
    lines.push('', '⏸ Held by design - ownership unresolved, not a failure:');
    if (report.excludedFromA1.length > 0) {
      lines.push(`  ${report.excludedFromA1.length} A1 candidate(s): pointer contested by an S4 group this run`);
    }
    if (report.excludedFromI1.length > 0) {
      lines.push(`  ${report.excludedFromI1.length} I1 candidate(s): BHC_ID is S1-disputed this run`);
    }
  }

  // Out of scope. Deliberately worded so it can never be read as "Fix tried
  // and gave up" - Fix has no pass for these codes at all.
  if (outOfScope.length > 0) {
    lines.push('', "🚫 Not in Fix's scope - always needs manual review:");
    for (const [code, n] of outOfScope) {
      const meta = ISSUE_META[code as IssueCode];
      lines.push(`  ${code} ${meta.type} (${meta.severity}) ×${n}`);
    }
  }

  const failures = writeFailures(report);
  const tail: string[] = [];
  if (failures.total > 0) {
    // Always attributed, even for a single failure - one format, and the post
    // alone always names the pass to open.
    const where = failures.byCategory.map((c) => `${c.n} ${c.code}`).join(', ');
    tail.push(`${failures.total} write failure(s): ${where}`);
  }
  if (report.warnings.length > 0) tail.push(`${report.warnings.length} warning(s)`);
  if (tail.length > 0) lines.push('', `⚠ ${tail.join(', ')} - see the run artifact`);

  lines.push('Review: aida.hougham.us (Reconciler_Report tab in the CRM sheet)');
  return lines.join('\n');
}
