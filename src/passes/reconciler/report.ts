/**
 * PASS 5 report shaping + PASS 6 Slack text.
 *
 * COLUMN ORDER IS THE LIVE TAB'S, NOT THE SPEC'S. Verified directly against the
 * real Reconciler_Report on 2026-08-18: Severity sits at K, BEFORE Expected (L)
 * and Found (M). The spec text lists Expected/Found before Severity. The sheet
 * wins - it is what Aida reads - and tonight's real Reconciler run flagged the
 * same drift in its own PASS 5 notes.
 *
 *   A Run_ID | B Checked_At | C BHC_ID | D Full_Name | E Master_Row
 *   F Google_Row | G Attio_Record_ID | H Location | I Issue_Code
 *   J Issue_Type | K Severity | L Expected | M Found | N Notes
 */

import { ISSUE_META, type Finding, type ReconcilerCounts, type Severity } from './types.js';

export const REPORT_COLUMNS = 14; // A-N

export function toReportRow(f: Finding, opts: { runId: string; checkedAt: string }): readonly unknown[] {
  const meta = ISSUE_META[f.code];
  return [
    opts.runId,            // A
    opts.checkedAt,        // B
    f.row.bhcId,           // C
    f.row.fullName,        // D
    f.row.masterRow,       // E
    f.row.googleRow ?? '', // F
    f.row.attioRecordId,   // G
    f.row.location,        // H
    f.code,                // I
    meta.type,             // J
    meta.severity,         // K  <- live order
    f.expected,            // L
    f.found,               // M
    f.notes,               // N
  ];
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) out[ISSUE_META[f.code].severity] += 1;
  return out;
}

/**
 * Run-ID provenance language. RECON-FIX-* is a sibling repair routine, never
 * "tampering"; anything else is described neutrally. The spec is explicit that
 * this routine reports drift and does not assign intent.
 */
export function describeForeignRunIds(runIds: readonly string[]): string | null {
  const recon = runIds.filter((r) => /^RECON-\d+$/.test(r));
  const fix = runIds.filter((r) => /^RECON-FIX-/.test(r));
  const other = runIds.filter((r) => !recon.includes(r) && !fix.includes(r) && r.trim() !== '');
  const parts: string[] = [];
  if (fix.length > 0) {
    parts.push(`  -> ${fix.length} finding(s) reference prior ReconcilerFix corrections - verify accuracy.`);
  }
  if (other.length > 0) {
    parts.push(`  -> ${other.length} finding(s) reference an unrecognized source - may warrant review.`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export function buildSlackMessage(args: {
  runId: string;
  counts: ReconcilerCounts;
  a5Count: number;
  i1Count: number;
  ncCount: number;
  foreignRunIds: readonly string[];
}): string {
  const { runId, counts, a5Count, i1Count, ncCount } = args;
  const supersededTail = counts.superseded > 0 ? ` ${counts.superseded} superseded row(s) skipped.` : '';

  if (counts.high === 0 && counts.medium === 0 && counts.low === 0 && counts.info === 0) {
    return `✓ Reconciler ${runId} - ${counts.totalRowsChecked} rows checked, all clean.${supersededTail}`;
  }

  const lines = [
    `🔍 Reconciler - ${runId}`,
    `${counts.totalRowsChecked} rows checked · ${counts.high} HIGH · ${counts.medium} MEDIUM · ${counts.low} LOW` +
      (counts.superseded > 0 ? ` · ${counts.superseded} superseded (retired, skipped)` : ''),
  ];
  if (counts.high > 0) lines.push(`⚠ ${counts.high} high-severity issues need attention - review Reconciler_Report tab`);
  if (a5Count > 0) lines.push(`  -> ${a5Count} name-mismatch flag(s) (A5) - pointer may reference wrong person`);
  if (i1Count > 0) lines.push(`  -> ${i1Count} identity-field drift(s) (I1) - ReconcilerFix will sync`);
  if (ncCount > 0) lines.push(`  -> ${ncCount} name conflict(s) queued for review in Aida`);
  if (counts.high === 0 && counts.medium === 0) lines.push('✓ No critical drift detected');
  const foreign = describeForeignRunIds(args.foreignRunIds);
  if (foreign) lines.push(foreign);
  lines.push('Review full report: aida.hougham.us (Reconciler_Report tab in the CRM sheet)');
  return lines.join('\n');
}
