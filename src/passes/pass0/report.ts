import type { Pass0Report } from './types.js';

export function renderReport(report: Pass0Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 0 — REPLY-PLACEHOLDER RECONCILIATION ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(
    `placeholders=${report.placeholderCount}  exact=${report.exactMatches.length}  ` +
      `inferred=${report.inferredMatches.length}  ambiguous=${report.ambiguousCount}  ` +
      `no_match=${report.noMatchCount}  (${report.stalePlaceholderCount} stale)`,
  );

  if (report.exactMatches.length > 0) {
    out.push('');
    out.push('EXACT MATCHES (Activity_Log closed live):');
    for (const m of report.exactMatches) out.push(`  • ${m.activityId} <- ${m.threadId}`);
  }

  if (report.inferredMatches.length > 0) {
    out.push('');
    out.push('INFERRED MATCHES (staged to Reconciliation_Queue, awaiting Bobby):');
    for (const m of report.inferredMatches) {
      out.push(`  • ${m.reconId}: ${m.placeholder.activityId} ~ ${m.candidate.threadId} ("${m.candidate.contactName}")`);
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
