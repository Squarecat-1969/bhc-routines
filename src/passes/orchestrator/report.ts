import type { LateEditionReport } from './types.js';

function line(label: string, value: string): string {
  return `  ${label.padEnd(28)} ${value}`;
}

/**
 * Every pass has its own `warnings: readonly string[]` — real diagnostics
 * like PASS 2.5's max_tokens/thinking-budget finding earlier tonight, or a
 * PASS 4 withheld-row explanation. Each pass's own standalone report always
 * surfaced these; the first version of this combined report didn't, which
 * meant a real warning could scroll past in the live log stream and never
 * appear in the "at a glance" summary at the bottom. Fixed: aggregate every
 * pass's warnings here, prefixed by pass name, so nothing that mattered
 * enough to warn about gets missed just because eight passes ran instead
 * of one.
 */
function collectWarnings(report: LateEditionReport): readonly string[] {
  const sections: Array<[string, readonly string[]]> = [
    ['PASS 0', report.pass0.warnings],
    ['PASS 1', report.pass1.warnings],
    ['PASS 2', report.pass2.warnings],
    ['PASS 2.5', report.pass25.warnings],
    ['PASS 3', report.pass3.warnings],
    ['PASS 4', report.pass4.warnings],
    ['PASS 4.5', report.pass45.warnings],
    ['PASS 5', report.pass5.warnings],
  ];
  return sections.flatMap(([label, warnings]) => warnings.map((w) => `[${label}] ${w}`));
}

export function renderReport(report: LateEditionReport): string {
  const out: string[] = [];
  out.push('');
  out.push('#'.repeat(100));
  out.push(`LATE EDITION — ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push('#'.repeat(100));

  out.push('');
  out.push('PASS 0 — Reply-Placeholder Reconciliation');
  out.push(line('aborted', String(report.pass0.aborted)));
  out.push(
    line(
      'exact / inferred / ambiguous',
      `${report.pass0.exactMatches.length} / ${report.pass0.inferredMatches.length} / ${report.pass0.ambiguousCount}`,
    ),
  );

  out.push('');
  out.push('PASS 1 — Housekeeping');
  out.push(line('aborted', String(report.pass1.aborted)));
  out.push(line('Brain_Complete resolved/survivors', `${report.pass1.brainCompleteResolvedCount} / ${report.pass1.brainCompleteSurvivorCount}`));

  out.push('');
  out.push('PASS 2 — Enrichment');
  out.push(line('aborted', String(report.pass2.aborted)));
  out.push(line('processed / written / noise', `${report.pass2.processedCount} / ${report.pass2.writtenCount} / ${report.pass2.noiseCount}`));
  out.push(line('enrichment failures / drift', `${report.pass2.enrichmentFailureCount} / ${report.pass2.driftCount}`));

  out.push('');
  out.push('PASS 2.5 — Task Reconciliation');
  out.push(line('aborted', String(report.pass25.aborted)));
  out.push(line('handled / stale / open', `${report.pass25.handledCount} / ${report.pass25.staleCount} / ${report.pass25.openCount}`));
  out.push(line('enqueued / superseded', `${report.pass25.enqueuedCount} / ${report.pass25.supersededCount}`));

  out.push('');
  out.push('PASS 3 — Slack Digest');
  out.push(line('aborted', String(report.pass3.aborted)));
  out.push(line('surfaced / filtered / posted', `${report.pass3.surfacedCount} / ${report.pass3.filteredCount} / ${report.pass3.posted}`));

  out.push('');
  out.push('PASS 4 — Attio Cadence Engine');
  out.push(line('eligible / written / failed', `${report.pass4.counts.eligible} / ${report.pass4.counts.written} / ${report.pass4.counts.failed}`));
  out.push(line('stalled / withheld', `${report.pass4.counts.stalled} / ${report.pass4.counts.withheld}`));

  out.push('');
  out.push('PASS 4.5 — Pipeline Cache');
  out.push(line('aborted', String(report.pass45.aborted)));

  out.push('');
  out.push('PASS 5 — Game Plan Generation');
  out.push(line('aborted', String(report.pass5.aborted)));
  out.push(line('plan items / written', `${report.pass5.planItemCount} / ${report.pass5.written}`));

  const warnings = collectWarnings(report);
  if (warnings.length > 0) {
    out.push('');
    out.push(`WARNINGS (${warnings.length}):`);
    for (const w of warnings) out.push(`  ⚠ ${w}`);
  }

  out.push('');
  out.push(`Started  ${report.startedAt}`);
  out.push(`Finished ${report.finishedAt}`);
  out.push('');

  return out.join('\n');
}
