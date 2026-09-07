/** The console report. Every verdict is shown with its reason. */

import type { ReresolutionReport } from './index.js';

export function renderReport(r: ReresolutionReport): string {
  const out: string[] = ['', '='.repeat(100),
    `IDENTITY RE-RESOLUTION ${r.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${r.runId}`, '='.repeat(100)];
  if (r.aborted) {
    // ⚠ NEVER "Nothing was written" unless that is knowable. See index.ts.
    const landed = r.writesMayHaveLanded
      ? '⚠ COLUMN-B WRITES MAY HAVE LANDED. Re-read Brain_Complete column B before re-running.'
      : 'Nothing was written — the run aborted before any write could be issued.';
    return [...out, '', `ABORTED — ${r.abortReason}`, landed, ''].join('\n');
  }

  out.push('', 'POPULATION');
  out.push(`  Brain_Complete rows        : ${r.totalRows}`);
  out.push(`  column B blank             : ${r.blankRows}`);
  out.push(`  corpus fingerprint         : ${r.fingerprint}`);
  out.push(`  derivation version         : ${r.derivationVersion}`);

  out.push('', 'RETRY GATE');
  const skippedTotal = Object.values(r.skipped).reduce((a, b) => a + b, 0);
  for (const [k, n] of Object.entries(r.skipped).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(n).padStart(4, ' ')}  skipped: ${k}`);
  }
  out.push(`  ${String(skippedTotal).padStart(4, ' ')}  skipped TOTAL`);
  out.push(`  ${String(r.attempted).padStart(4, ' ')}  attempted`);

  out.push('', 'CLASSIFICATION');
  for (const [k, n] of Object.entries(r.byClass).sort((a, b) => b[1] - a[1])) out.push(`  ${String(n).padStart(4, ' ')}  ${k}`);

  out.push('', 'VERDICTS');
  for (const [k, n] of Object.entries(r.byVerdict).sort((a, b) => b[1] - a[1])) out.push(`  ${String(n).padStart(4, ' ')}  ${k}`);

  const writes = r.outcomes.filter((o) => o.verdict === 'write');
  if (writes.length > 0) {
    out.push('', `ROWS THAT WOULD BE WRITTEN — ${writes.length}${r.dryRun ? '  (NOTHING WAS WRITTEN)' : ''}`);
    for (const o of writes) {
      out.push(
        `  row ${String(o.sheetRow).padStart(3)}  ${o.bhcId}  ${o.source.padEnd(9)} W=${(o.actionRequired || '-').padEnd(13)} ` +
          `${o.primaryEmail}${r.dryRun ? '' : o.written ? '  ✓ CONFIRMED' : '  ✗ NOT CONFIRMED'}`,
      );
      out.push(`         drift: clean · column C: ${JSON.stringify((o.contactName || '').slice(0, 60))}`);
    }
  }

  const withheld = r.outcomes.filter((o) => o.verdict.startsWith('withheld'));
  if (withheld.length > 0) {
    out.push('', `WITHHELD FOR A HUMAN — ${withheld.length}`);
    for (const o of withheld) {
      out.push(`  row ${String(o.sheetRow).padStart(3)}  ${o.bhcId ?? '-'}  ${o.verdict}`);
      out.push(`         ${o.detail}`);
    }
  }

  if (!r.dryRun) {
    out.push('', 'WRITES');
    out.push(`  column B attempted : ${r.writesAttempted}`);
    // CONFIRMED by reading the cell back, never the count we intended.
    out.push(`  column B CONFIRMED : ${r.writesConfirmed}`);
    out.push(`  state rows written : ${r.stateRowsWritten}`);
  }

  out.push('', '⚠ Part D reach is UNCHANGED — this pass writes column B and its own state tab, never AB or V.');

  if (r.warnings.length > 0) {
    out.push('', 'WARNINGS:');
    for (const w of r.warnings) out.push(`  ⚠ ${w}`);
  }
  out.push('');
  return out.join('\n');
}
