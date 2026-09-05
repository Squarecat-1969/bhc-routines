/** The console report. A dry run must be reviewable per tab before anything is written. */

import type { IndexMaintenanceReport } from './index.js';

export function renderReport(r: IndexMaintenanceReport): string {
  const out: string[] = [];
  out.push('');
  out.push('='.repeat(100));
  out.push(`INDEX MAINTENANCE ${r.dryRun ? 'DRY RUN' : 'LIVE RUN'} — ${r.runId}`);
  out.push('='.repeat(100));

  if (r.aborted) {
    out.push('', `ABORTED — ${r.abortReason}`, 'Nothing was written.', '');
    return out.join('\n');
  }

  out.push('', 'SOURCES READ');
  for (const s of r.sourcesRead) {
    out.push(`  ${s.label.padEnd(30)} ${String(s.chars).padStart(7)} chars · ${String(s.entries).padStart(3)} entries · preRead ${s.preReadMs}ms`);
  }

  out.push('', 'INDEX READ');
  for (const t of r.indexTabsRead) {
    out.push(`  ${t.title.padEnd(30)} ${String(t.chars).padStart(7)} chars · ${String(t.terms).padStart(3)} terms · ${String(t.references).padStart(4)} refs`);
  }
  out.push(`  controlled vocabulary: ${r.vocabularySize} term(s)`);
  if (r.duplicateTerms.length > 0) out.push(`  ⚠ defined in more than one GROUP tab: ${r.duplicateTerms.join(', ')}`);

  out.push('', 'WATERMARK');
  out.push(`  already indexed : ${r.watermarkSize} locator(s)`);
  out.push(`  unindexed       : ${r.unindexed.length}  ${r.unindexed.slice(0, 30).join(' ')}${r.unindexed.length > 30 ? ' …' : ''}`);

  out.push('', 'TERM ASSIGNMENT');
  out.push(`  LLM calls made : ${r.llmCallsMade}`);
  out.push(`  failures       : ${r.llmFailures}`);
  if (r.rejectedTerms.length > 0) {
    out.push(`  ⚠ ${r.rejectedTerms.length} term(s) returned that are NOT in the vocabulary — routed to ADDITIONAL TERMS as proposals:`);
    out.push(`      ${r.rejectedTerms.join(', ')}`);
  }
  if (r.missingFailureClass.length > 0) {
    out.push(`  ⚠ no failure-class term (§089.4 makes one mandatory on an incident/bug/correction): ${r.missingFailureClass.join(', ')}`);
  }

  out.push('', `PLANNED WRITES — ${r.planned.length}${r.dryRun ? '  (NOTHING WAS WRITTEN)' : ''}`);
  for (const [tab, n] of Object.entries(r.plannedByTab)) out.push(`  ${String(n).padStart(4, ' ')}  ${tab}`);
  out.push('');
  for (const w of r.planned) {
    if (w.kind === 'update-count') {
      out.push(`  [count]  ${w.tabTitle} · ${w.term}`);
      out.push(`             ${JSON.stringify(w.fromLine)}`);
      out.push(`          -> ${JSON.stringify(w.toLine)}`);
    } else if (w.kind === 'insert-reference') {
      out.push(`  [ref]    ${w.tabTitle} · ${w.term} · ${w.locator}`);
      out.push(`           after ${JSON.stringify(w.afterLine.slice(0, 90))}`);
      out.push(`           +     ${JSON.stringify(w.text)}`);
    } else {
      out.push(`  [term]   ${w.tabTitle} · PROPOSED "${w.term}" from ${w.locator}`);
      out.push(`           +     ${JSON.stringify(w.text.slice(0, 160))}`);
    }
  }

  if (!r.dryRun) {
    out.push('', 'WRITE RESULTS');
    out.push(`  attempted : ${r.writesAttempted}`);
    // CONFIRMED by the route's byte comparison, never the count we intended.
    out.push(`  CONFIRMED : ${r.writesConfirmed}`);
    const failed = r.outcomes.filter((o) => !o.verified);
    for (const f of failed) out.push(`  ⚠ FAILED ${f.write.kind} · ${f.write.tabTitle} · ${f.write.term}: ${f.detail}`);
  }

  if (r.warnings.length > 0) {
    out.push('', 'WARNINGS:');
    for (const w of r.warnings) out.push(`  ⚠ ${w}`);
  }
  out.push('');
  return out.join('\n');
}
