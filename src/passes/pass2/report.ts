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

  const actionable = report.previews.filter((p) => !p.isNoise);
  const noise = report.previews.filter((p) => p.isNoise);

  if (actionable.length > 0) {
    out.push('');
    out.push('THREADS (real content — review before trusting this at scale):');
    for (const p of actionable) {
      out.push('');
      out.push(`  ── ${p.contactName ?? '⚠ unresolved'} — ${p.subject} (${p.direction})`);
      out.push(`     ${p.actionRequired} | ${p.outcome}`);
      out.push(`     Summary: ${p.runningSummary}`);
      if (p.keyCommitments) out.push(`     Commitments: ${p.keyCommitments}`);
      if (p.responseDraft) out.push(`     Draft: "${p.responseDraft}"`);
      if (p.personalContextFound) out.push(`     (personal context extracted)`);
      if (p.driftNotes.length > 0) out.push(`     ⚠ drift: ${p.driftNotes.join('; ')}`);
    }
  }

  if (noise.length > 0) {
    out.push('');
    out.push(`FILTERED AS NOISE (no LLM call): ${noise.map((p) => `${p.subject} [${p.noiseTag}]`).join(', ')}`);
  }

  if (report.warnings.length > 0) {
    out.push('');
    out.push('WARNINGS:');
    for (const w of report.warnings) out.push(`  ⚠ ${w}`);
  }

  out.push('');
  return out.join('\n');
}
