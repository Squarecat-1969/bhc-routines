import type { Pass5Report } from './types.js';

export function renderReport(report: Pass5Report): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`PASS 5 — GAME PLAN ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — digesting ${report.runId}`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push(
    `open_tasks=${report.openTaskCount}  brain_complete_rows=${report.brainCompleteRowCount}  ` +
      `pipeline_entries=${report.pipelineEntryCount}  meetings_to_review=${report.meetingsToReviewCount}`,
  );
  out.push(`plan_items=${report.planItemCount}  written=${report.written}`);

  if (report.gamePlan) {
    out.push('');
    out.push('BRIEF:');
    out.push(report.gamePlan.brief);

    out.push('');
    out.push('MISSION STATUS:');
    for (const [track, status] of Object.entries(report.gamePlan.missionStatus)) {
      out.push(`  ${track}: active=${status.active} stalled=${status.stalled} nextTouch=${status.nextTouch ?? 'n/a'}`);
    }

    out.push('');
    out.push('COUNTS:');
    out.push(`  ${JSON.stringify(report.gamePlan.counts)}`);

    if (report.gamePlan.plan.length > 0) {
      out.push('');
      out.push('PLAN:');
      for (const item of report.gamePlan.plan) {
        out.push(`  [${item.priority}] (${item.type}) ${item.contact} — ${item.reason}`);
      }
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
