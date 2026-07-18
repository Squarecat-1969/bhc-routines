import type { Pass1Report } from './types.js';

export function renderReport(report: Pass1Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 1 — HOUSEKEEPING ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('(Logged and stopped — does not block later passes.)');
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(
    `Brain_Complete: ${report.brainCompletePriorCount} row(s) -> ${report.brainCompleteResolvedCount} deleted, ` +
      `${report.brainCompleteSurvivorCount} survivor(s)`,
  );
  out.push(
    `Thread_Staging: ${report.threadStagingTotalCount} row(s) total, ${report.workingSet.length} in tonight's working set`,
  );

  if (report.warnings.length > 0) {
    out.push('');
    out.push('WARNINGS:');
    for (const w of report.warnings) out.push(`  ⚠ ${w}`);
  }

  out.push('');
  return out.join('\n');
}
