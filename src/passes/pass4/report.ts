/**
 * Human-readable rendering of a PASS 4 report, plus the 4f Slack addendum text.
 *
 * The dry-run table is the actual review artifact — it is what gets eyeballed
 * against expected values before live writes are switched on, so it shows the
 * inputs (stage, tier, last touch) next to the outputs, not just the outputs.
 */

import { MAX_KNOWN_STAGE } from '../../config/constants.js';
import type { CadenceRow, Pass4Report } from './types.js';

function pad(s: string, n: number): string {
  const clean = s.length > n ? `${s.slice(0, n - 1)}…` : s;
  return clean.padEnd(n, ' ');
}

function describeSource(r: CadenceRow): string {
  return r.activeStageNum >= 1
    ? `${r.activeTrack ?? '?'} S${r.activeStageNum}`
    : `Tier ${r.tier}${r.tierDefaulted ? '*' : ''}`;
}

export function renderTable(rows: readonly CadenceRow[]): string {
  const header = [
    pad('CONTACT', 26),
    pad('BHC_ID', 11),
    // Wide enough for "Tier Peripheral*" — the trailing * marks a defaulted
    // tier and must never be the character that gets truncated away.
    pad('BASIS', 17),
    pad('EVERY', 6),
    pad('LAST TOUCH', 12),
    pad('AGE', 6),
    pad('NEXT CHECK-IN', 14),
    pad('MODE', 11),
    'FLAGS',
  ].join(' ');

  const lines = rows.map((r) => {
    const flags: string[] = [];
    if (r.withheld) flags.push(`WITHHELD:${r.withheld}`);
    if (r.stalled) flags.push('STALLED');
    if (r.overdueCatchUp) flags.push('CATCH-UP');
    return [
      pad(r.name ?? '(no name)', 26),
      pad(r.bhcId ?? '—', 11),
      pad(describeSource(r), 17),
      pad(`${r.cadenceDays}d`, 6),
      pad(r.lastTouch ?? 'unknown', 12),
      pad(r.daysSince === null ? '—' : `${r.daysSince}d`, 6),
      pad(r.withheld ? '—' : r.nextCheckIn, 14),
      pad(r.withheld ? '—' : r.touchMode, 11),
      flags.join(' '),
    ].join(' ');
  });

  return [header, '-'.repeat(header.length), ...lines].join('\n');
}

export function renderReport(report: Pass4Report): string {
  const c = report.counts;
  const out: string[] = [];

  out.push('');
  out.push('='.repeat(120));
  out.push(`PASS 4 — CADENCE ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push(`today=${report.today} (${report.timezone})  pipeline_entries=${report.pipelineEntryCount}`);
  out.push(`master_id_rows=${report.masterIdRowCount}  tier_index=${report.tierIndexSize} ("${report.tierHeaderTitle}")`);
  out.push('='.repeat(120));
  out.push('');
  out.push(renderTable(report.rows));
  out.push('');
  out.push(
    `eligible=${c.eligible}  withheld=${c.withheld}  written=${c.written}  ` +
      `failed=${c.failed}  read_back_mismatch=${c.verifiedMismatch}  stalled=${c.stalled}`,
  );
  out.push(`unmapped_to_master_id=${c.unmappedToMasterId}  tier_defaulted=${c.tierDefaulted}  (* = defaulted tier)`);

  const withheld = report.rows.filter((r) => r.withheld !== null);
  if (withheld.length > 0) {
    out.push('');
    out.push(`WITHHELD — ${withheld.length} contact(s), no cadence written:`);
    for (const r of withheld) {
      out.push(`  • ${r.name ?? r.recordId} [${r.withheld}]`);
      for (const n of r.notes) out.push(`      ${n}`);
    }
  }

  const noted = report.rows.filter((r) => r.withheld === null && r.notes.length > 0);
  if (noted.length > 0) {
    out.push('');
    out.push('NOTES:');
    for (const r of noted) {
      for (const n of r.notes) out.push(`  • ${r.name ?? r.recordId}: ${n}`);
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
 * Spec 4f — the #aida cadence addendum.
 *
 * The spec's message reports "{total} pipeline contacts updated · {stalled} stalled".
 * We report written (not total), because claiming a contact was updated when its
 * write was withheld or failed would be reporting success on work not done —
 * the same class of error Non-negotiable #8 forbids for the PASS 3 digest.
 */
export function buildSlackAddendum(report: Pass4Report): string {
  const c = report.counts;

  // The spec's zero-alarm diagnoses a live run that wrote nothing. A dry run
  // writes nothing by design, so firing it there would cry wolf.
  if (!report.dryRun && c.written === 0 && report.rows.length > 0) {
    return '⚠ Cadence PASS 4 — 0 contacts updated. Check Attio pipeline list or connector.';
  }

  const lines: string[] = report.dryRun
    ? [`📅 Cadence (DRY RUN — nothing written) — ${c.eligible} pipeline contacts would update · ${c.stalled} stalled`]
    : [`📅 Cadence — ${c.written} pipeline contacts updated · ${c.stalled} stalled`];

  const stalledRows = report.rows.filter((r) => r.stalled && r.withheld === null);
  if (stalledRows.length > 0) {
    lines.push('⚠ Stalled:');
    for (const r of stalledRows) {
      lines.push(`• ${r.name ?? r.recordId} — ${r.daysSince}d since last touch (${r.reasonBase})`);
    }
  }

  if (c.withheld > 0) {
    const withheldRows = report.rows.filter((r) => r.withheld !== null);
    const stageIssues = withheldRows.filter((r) => r.withheld === 'STAGE_OUT_OF_RANGE');
    const identityIssues = withheldRows.filter((r) => r.withheld !== 'STAGE_OUT_OF_RANGE');

    if (stageIssues.length > 0) {
      const names = stageIssues.map((r) => r.name ?? r.recordId).join(', ');
      lines.push(
        `⚠ ${stageIssues.length} contact(s) show a pipeline stage beyond Stage ${MAX_KNOWN_STAGE} — ` +
          `not an identity problem, an Attio data error: ${names}. Correct the stage value in Attio.`,
      );
    }
    if (identityIssues.length > 0) {
      const names = identityIssues.map((r) => r.name ?? r.recordId).join(', ');
      lines.push(
        `⚠ ${identityIssues.length} contact(s) withheld — identity check failed, cadence not written: ${names}. Run the Reconciler.`,
      );
    }
  }

  if (c.failed > 0 || c.verifiedMismatch > 0) {
    lines.push(`⚠ ${c.failed} write failure(s) · ${c.verifiedMismatch} read-back mismatch(es).`);
  }

  return lines.join('\n');
}
