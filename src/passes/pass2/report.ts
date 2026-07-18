import type { Pass2Report } from './index.js';

export function renderReport(report: Pass2Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 2 — ENRICHMENT ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(
    `working_set=${report.workingSetCount}  processed=${report.processedCount}  written=${report.writtenCount}  ` +
      `noise=${report.noiseCount}`,
  );
  out.push(`enrichment_failures=${report.enrichmentFailureCount}  actionable=${report.actionableCount}  drift=${report.driftCount}`);

  if (report.warnings.length > 0) {
    out.push('');
    out.push('WARNINGS:');
    for (const w of report.warnings) out.push(`  ⚠ ${w}`);
  }

  out.push('');
  return out.join('\n');
}
