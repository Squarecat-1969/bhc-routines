import type { Pass25Report } from './types.js';

export function renderReport(report: Pass25Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 2.5 — TASK RECONCILIATION ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(`open_tasks=${report.openTaskCount}  clusters=${report.clusterCount}`);
  out.push(`handled=${report.handledCount}  stale=${report.staleCount}  open=${report.openCount}`);
  out.push(`enqueued=${report.enqueuedCount}  superseded=${report.supersededCount}`);

  if (report.results.length > 0) {
    out.push('');
    out.push('RESULTS:');
    for (const r of report.results) {
      out.push('');
      out.push(`  ── ${r.cluster.contactName} — ${r.cluster.description}`);
      out.push(`     ${r.verdict} | confidence=${r.confidence || 'n/a'}`);
      if (r.evidenceQuote) out.push(`     Evidence: "${r.evidenceQuote}"`);
      out.push(`     ${r.brainReasoning}`);
    }
  }

  if (report.warnings.length > 0) {
    out.push('');
    out.push('WARNINGS:');
    for (const w of report.warnings) out.push(`  ⚠ ${w}`);
  }

  out.push('');
  return out.join('\n');
}

/** Spec 2.5f, reused verbatim by PASS 3's digest assembly. */
export function buildSlackNote(report: Pass25Report): string {
  return `🗂️ Task reconciliation: ${report.handledCount} likely handled · ${report.staleCount} likely stale · ${report.openCount} still open — review & Accept/Deny in Aida. Nothing auto-closed.`;
}
