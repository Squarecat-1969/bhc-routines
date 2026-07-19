import type { Pass3Report } from './types.js';

export function renderReport(report: Pass3Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 3 — SLACK DIGEST ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — digesting ${report.runId}`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(`rows=${report.rowCount}  surfaced=${report.surfacedCount}  filtered=${report.filteredCount}  kind=${report.bodyKind}  posted=${report.posted}`);

  if (report.digestBody) {
    out.push('');
    out.push('DIGEST BODY:');
    out.push('-'.repeat(100));
    out.push(report.digestBody);
    out.push('-'.repeat(100));
  }

  if (report.warnings.length > 0) {
    out.push('');
    out.push('WARNINGS:');
    for (const w of report.warnings) out.push(`  ⚠ ${w}`);
  }

  out.push('');
  return out.join('\n');
}
