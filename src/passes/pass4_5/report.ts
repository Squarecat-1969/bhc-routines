import type { Pass45Report } from './types.js';

export function renderReport(report: Pass45Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 4.5 — PIPELINE CACHE ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push(`today=${report.today} (UTC)`);
  out.push('='.repeat(100));

  if (report.skippedTabAbsent) {
    out.push('');
    out.push('SKIPPED — Pipeline_Cache tab absent or unreadable. Pass did not run. Tab was NOT created.');
    out.push('');
    return out.join('\n');
  }

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('(Logged and stopped per spec 4.5f — this does not block PASS 5.)');
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(
    `targets=${report.targetCount}  written=${report.rows.length}  ` +
      `pipeline=${report.pipelineCount}  identity_only=${report.liteCount}`,
  );
  out.push(
    `withheld=${report.withheld.length}  (mismatch=${report.mismatchCount}  unresolved=${report.unresolvedCount})`,
  );
  out.push(`name_conflicts_enqueued=${report.nameConflictsEnqueued.length}`);

  if (report.withheld.length > 0) {
    out.push('');
    out.push(`WITHHELD — ${report.withheld.length} target(s), no cache row written:`);
    for (const w of report.withheld) {
      out.push(`  • ${w.name ?? w.bhcId} [${w.reason}] ${w.notes}`);
    }
  }

  if (report.nameConflictsEnqueued.length > 0) {
    out.push('');
    out.push('NAME_CONFLICTS ENQUEUED:');
    for (const nc of report.nameConflictsEnqueued) {
      out.push(`  • ${nc.bhcId}: "${nc.oldName}" → "${nc.newName}"`);
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

/**
 * Spec 4.5g:
 *   🧊 Pipeline cache — {written} records cached ({pipeline} pipeline · {lite} identity-only){ · {withheld} withheld for drift}
 * withheld fragment appended only when withheld > 0. Second line only if mismatch_count > 0.
 */
export function buildSlackAddendum(report: Pass45Report): string {
  if (report.skippedTabAbsent) {
    return 'PIPELINE_CACHE: tab absent — skipping PASS 4.5';
  }
  if (report.aborted) {
    return `⚠ PASS 4.5 aborted: ${report.abortReason}`;
  }

  const withheldTotal = report.mismatchCount + report.unresolvedCount;
  const withheldFragment = withheldTotal > 0 ? ` · ${withheldTotal} withheld for drift` : '';
  const lines = [
    `🧊 Pipeline cache — ${report.rows.length} records cached ` +
      `(${report.pipelineCount} pipeline · ${report.liteCount} identity-only)${withheldFragment}`,
  ];

  if (report.mismatchCount > 0) {
    const names = report.withheld
      .filter((w) => w.reason === 'ID_MISMATCH')
      .map((w) => w.name ?? w.bhcId)
      .join(', ');
    lines.push(`⚠ ${report.mismatchCount} Pipeline_Cache mismatches — pointer drift, needs manual review: ${names}. Run the Reconciler.`);
  }

  return lines.join('\n');
}
