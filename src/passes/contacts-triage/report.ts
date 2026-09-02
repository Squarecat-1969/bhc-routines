/**
 * STEP 7 — the console report and the #aida post.
 *
 * Two audiences. The console report is for tuning: it prints the full
 * deterministic band distribution prominently, because the 30/85 thresholds
 * and the weights are a starting hypothesis that gets tuned against exactly
 * that histogram on run one. The Slack post is for Bobby's morning, and says
 * plainly when nothing needs his attention.
 */

import {
  BAND_JUNK_MAX,
  BAND_KEEPER_MIN,
  COMPROMISE_EXPECTED,
  COMPROMISE_REASON,
  EXPECTED_UNBRIDGED,
  LLM_SCORE_MAX,
  LLM_SCORE_MIN,
} from '../../config/triage-constants.js';
import type { BandDistribution, TriageReport } from './types.js';

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

/** A 10-point histogram, drawn — the shape is the point, not the numbers. */
export function renderHistogram(dist: BandDistribution): string[] {
  const total = dist.buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return ['  (nothing scored)'];
  const max = Math.max(...dist.buckets);
  const lines: string[] = [];

  dist.buckets.forEach((count, i) => {
    const label = i === 10 ? '100   ' : `${String(i * 10).padStart(2, ' ')}-${String(i * 10 + 9).padStart(2, ' ')} `;
    const bar = '█'.repeat(max === 0 ? 0 : Math.round((count / max) * 40));
    const bandMark =
      i * 10 + 9 <= BAND_JUNK_MAX ? 'junk' : i * 10 >= BAND_KEEPER_MIN ? 'keep' : i * 10 + 9 < LLM_SCORE_MIN ? '·' : '';
    lines.push(`  ${label} ${String(count).padStart(4, ' ')} ${bar}${count > 0 ? ` ${bandMark}` : ''}`);
  });

  return lines;
}

export function renderReport(report: TriageReport): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`CONTACTS TRIAGE ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${report.runId}`);
  out.push(`today=${report.today} (UTC)`);
  out.push('='.repeat(100));

  if (report.aborted) {
    out.push('');
    out.push(`ABORTED — ${report.abortReason}`);
    out.push('Nothing was written. Fix the cause and re-run.');
    out.push('');
    return out.join('\n');
  }

  // --- STEP 1
  out.push('');
  out.push('STEP 1 — ENUMERATION');
  out.push(`  total people in Attio    : ${report.totalPeople}`);
  out.push(`  with bhc_contact_id      : ${report.bridgedCount}`);
  out.push(`  unbridged (candidates)   : ${report.unbridgedCount}  (build spec expected ~${EXPECTED_UNBRIDGED})`);
  out.push(`  cross-check              : ${report.enumerationCrossCheck.toUpperCase()} — ${report.enumerationCrossCheckDetail}`);

  // --- STEP 1b
  out.push('');
  out.push('STEP 1b — SUPPRESSION (a human already ruled on these)');
  out.push(
    `  Master_ID SUPERSEDED rows seen : ${report.supersededRowsSeen}` +
      `  (${report.retiredIdentitiesIndexed} retired identities indexed, ` +
      `${report.mergeTombstonesIgnored} merge tombstones ignored)`,
  );
  if (report.activeSupersededRows.length > 0) {
    out.push(
      `  SUPERSEDED but still active    : row(s) ${report.activeSupersededRows.join(', ')} carry a BHC_ID ` +
        'AND a name — not used as suppression sources',
    );
  }
  if (report.retiredIdentitiesIndexed === 0) {
    out.push('  ⚠ THE SUPPRESSION INDEX IS EMPTY — this gate did not fire. Verify Master_ID column order.');
  }
  out.push(`  suppressed this run            : ${report.suppressed.length}`);
  for (const [kind, count] of Object.entries(report.suppressedByKind).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(count).padStart(4, ' ')}  ${kind}`);
  }
  // ⚠ The quoted annotation is the whole point. A suppressed record that
  // cannot be audited from the report is indistinguishable from a dropped one.
  const fromMaster = report.suppressed.filter((s) => s.source === 'master-id-superseded');
  if (fromMaster.length > 0) {
    out.push('');
    out.push('  retired identities re-created by Attio and suppressed:');
    for (const s of fromMaster) {
      out.push(`    ${s.name} <${s.email}>`);
      out.push(`      ${s.reason}`);
    }
  }

  // --- STEP 2
  out.push('');
  out.push('STEP 2 — HARD EXCLUDES (logged, never shown as cards)');
  const excludedTotal = Object.values(report.excludedByReason).reduce((a, b) => a + b, 0);
  if (excludedTotal === 0) {
    out.push('  none');
  } else {
    for (const [reason, count] of Object.entries(report.excludedByReason).sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(count).padStart(4, ' ')}  ${reason}`);
    }
    out.push(`  ${String(excludedTotal).padStart(4, ' ')}  TOTAL`);
  }
  out.push(`  already in Contact_Exclusions from a prior run, skipped: ${report.alreadyExcludedSkipped}`);
  if (!report.compromiseCohortInRange) {
    out.push('');
    out.push(
      `  ⚠ COMPROMISE COHORT DRIFT — the ${COMPROMISE_REASON} window matched ${report.compromiseCohortCount} ` +
        `record(s), not the expected ~${COMPROMISE_EXPECTED}. The cohort definition may have drifted; ` +
        'check the window before trusting this run\'s exclusions.',
    );
  }

  // --- STEP 3/4
  out.push('');
  out.push('STEP 3 — DETERMINISTIC BAND DISTRIBUTION  ← the number to tune against');
  out.push(
    `  keepers (>=${BAND_KEEPER_MIN}): ${report.deterministicDistribution.keepers}   ` +
      `unclear: ${report.deterministicDistribution.unclear}   ` +
      `junk (<=${BAND_JUNK_MAX}): ${report.deterministicDistribution.junk}`,
  );
  out.push(...renderHistogram(report.deterministicDistribution));

  out.push('');
  out.push(`STEP 4 — LLM GATE (readable evidence AND score ${LLM_SCORE_MIN}-${LLM_SCORE_MAX})`);
  out.push(`  in score range    : ${report.llmBandCount}`);
  out.push(`  ...of those, with readable evidence (ELIGIBLE): ${report.llmEligible}`);
  out.push(`  calls made        : ${report.llmCallsMade}`);
  out.push(`  failures (fallback): ${report.llmFailures}`);
  if (report.llmSkippedOverCap > 0) {
    out.push(`  ⚠ skipped over cap : ${report.llmSkippedOverCap} — kept their deterministic score`);
  }
  out.push(
    `  clamp events      : ${report.clampEvents}` +
      (report.llmCallsMade > 0 ? ` (${pct(report.clampEvents, report.llmCallsMade)} of calls)` : ''),
  );
  if (report.clampEvents > 0 && report.llmCallsMade > 0 && report.clampEvents / report.llmCallsMade > 0.25) {
    out.push('  ⚠ frequent clamping — the thresholds or the deterministic weights need tuning.');
  }
  if (report.strengthMissingCount > 0) {
    out.push(`  ⚠ no Attio connection strength for ${report.strengthMissingCount} contact(s) — scored on identity and span alone`);
  }

  out.push('');
  out.push('FINAL BAND DISTRIBUTION (after LLM overrides)');
  out.push(
    `  keepers: ${report.finalDistribution.keepers}   ` +
      `unclear: ${report.finalDistribution.unclear}   ` +
      `junk: ${report.finalDistribution.junk}`,
  );
  out.push(...renderHistogram(report.finalDistribution));

  // --- STEP 5/6
  out.push('');
  out.push('STEP 5/6 — QUEUE');
  for (const [action, count] of Object.entries(report.mergeCounts)) {
    if (count > 0) out.push(`  ${String(count).padStart(4, ' ')}  ${action}`);
  }
  out.push(`  rows ${report.dryRun ? 'that would be written' : 'written'}: ${report.queueRowsWritten}`);
  out.push(`  Contact_Exclusions rows ${report.dryRun ? 'that would be appended' : 'appended'}: ${report.exclusionsAppended}`);
  if (report.readBackVerified !== null) {
    out.push(`  read-back: ${report.readBackVerified ? 'VERIFIED' : 'FAILED'} — ${report.readBackDetail}`);
  }

  // --- Top of the queue, so a dry run is actually reviewable.
  const keepers = report.scored.filter((s) => s.column === 'keepers').sort((a, b) => b.finalScore - a.finalScore);
  if (keepers.length > 0) {
    out.push('');
    out.push(`TOP KEEPERS (${Math.min(15, keepers.length)} of ${keepers.length})`);
    for (const s of keepers.slice(0, 15)) {
      out.push(`  ${String(s.finalScore).padStart(3, ' ')}  ${s.contact.name ?? '(no name)'} <${s.contact.primaryEmail ?? '—'}>`);
      out.push(`       ${s.reason}`);
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

/** STEP 7's #aida post. */
export function buildSlackMessage(report: TriageReport): string {
  if (report.aborted) {
    return `⚠ Contacts triage aborted — ${report.abortReason}. Nothing was written.`;
  }

  const lines: string[] = [];
  const label = report.dryRun ? '📇 Contacts triage (dry run)' : '📇 Contacts triage';
  lines.push(`${label} — ${report.unbridgedCount} unbridged of ${report.totalPeople} people in Attio`);

  const excludedTotal = Object.values(report.excludedByReason).reduce((a, b) => a + b, 0);
  const compromise = report.excludedByReason[COMPROMISE_REASON] ?? 0;
  lines.push(
    `Excluded ${excludedTotal} — ${compromise} from the 2026-07-22 compromise blast` +
      (excludedTotal - compromise > 0 ? `, ${excludedTotal - compromise} other (role addresses, internal, bounces)` : ''),
  );

  lines.push(
    `Scored ${report.scored.length} — ${report.finalDistribution.keepers} keepers · ` +
      `${report.finalDistribution.unclear} unclear · ${report.finalDistribution.junk} junk`,
  );

  const llmBits = [`${report.llmCallsMade} LLM call(s)`];
  if (report.clampEvents > 0) llmBits.push(`${report.clampEvents} clamped`);
  if (report.llmFailures > 0) llmBits.push(`${report.llmFailures} failed → deterministic fallback`);
  lines.push(llmBits.join(' · '));

  if (!report.compromiseCohortInRange) {
    lines.push(
      `⚠ Compromise cohort matched ${report.compromiseCohortCount}, expected ~${COMPROMISE_EXPECTED} — the cohort definition may have drifted.`,
    );
  }
  if (report.enumerationCrossCheck === 'unavailable') {
    lines.push('⚠ Enumeration cross-check could not be run — count rests on the full walk alone.');
  }
  if (report.strengthMissingCount > 0) {
    lines.push(`⚠ No Attio connection strength for ${report.strengthMissingCount} contact(s) — scored on identity and span alone.`);
  }
  if (report.readBackVerified === false) {
    lines.push(`⚠ Read-back FAILED — ${report.readBackDetail}`);
  }

  const needsBobby =
    report.finalDistribution.keepers + report.finalDistribution.unclear + report.finalDistribution.junk;
  if (report.dryRun) {
    lines.push('Dry run — nothing written to either tab.');
  } else if (needsBobby === 0) {
    lines.push('No action needed — nothing new to triage.');
  } else {
    lines.push(`${report.queueRowsWritten} row(s) in Contacts_Triage_Queue, ready to review.`);
  }

  return lines.join('\n');
}
