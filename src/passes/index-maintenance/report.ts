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

  // ⚠ TRUNCATION IS A NAMED, TOP-LEVEL SECTION — NOT A WARNING AND NOT
  // INFERRED FROM A CHARACTER COUNT. A section indexed from its first N
  // characters produces reference lines byte-indistinguishable from one built
  // on the whole of it, so if this does not print, nothing else says it.
  out.push('', 'PARTIALLY READ');
  if (r.truncated.length === 0) {
    out.push('  none — every unit reached the prompt in full');
  } else {
    out.push(`  ⚠ ${r.truncated.length} unit(s) DID NOT reach the prompt in full:`);
    for (const t of r.truncated) {
      const pct = t.fullLength > 0 ? Math.round((t.readChars / t.fullLength) * 100) : 0;
      out.push(`    ${t.locator}`);
      out.push(`       read ${t.readChars} of ${t.fullLength} chars (${pct}%) — ${t.fullLength - t.readChars} unread`);
    }
    out.push('  Their index entries describe only the part that was read.');
  }

  if (r.planSections > 0) {
    out.push('', "THE DEVELOPER'S PLAN");
    out.push(`  sections found        : ${r.planSections}`);
    out.push(`  already referenced    : ${r.planAlreadyReferenced}  (UNTOUCHED — provenance unknown, add-only)`);
    out.push(`  never indexed         : ${r.planSections - r.planAlreadyReferenced}`);
    if (!r.planStateActive) {
      out.push('  ⚠ NO CONTENT HASHES RECORDED — drift cannot be reported for any section this run.');
    }
    const changed = r.planDrift.filter((d) => d.verdict === 'CHANGED');
    const unseen = r.planDrift.filter((d) => d.verdict === 'unseen');
    out.push(`  hashes: ${r.planDrift.length - changed.length - unseen.length} unchanged · ${changed.length} CHANGED · ${unseen.length} first seen`);
    if (changed.length > 0) {
      // The real deliverable: a stale index that says which parts are stale.
      out.push(`  ⚠ ${changed.length} section(s) REWRITTEN since they were indexed — their references now describe older text:`);
      for (const d of changed) out.push(`    ${d.locator}  (${d.chars} chars, indexed by ${d.indexedBy})`);
      out.push('  Nothing is repaired automatically. Removing a superseded reference is a human act.');
    }
  }

  out.push('', 'WATERMARK');
  out.push(`  already indexed : ${r.watermarkSize} locator(s)`);
  out.push(`  unindexed       : ${r.unindexed.length}  ${r.unindexed.slice(0, 30).join(' ')}${r.unindexed.length > 30 ? ' …' : ''}`);

  // ⚠ BLOCKED ENTRIES ARE REPORTED BY NAME ON EVERY RUN, whether or not
  // anything else happened. A blocked entry that vanishes from the report
  // makes the backlog look closed, which is the same defect in a new costume.
  out.push('', 'BLOCKED ENTRIES');
  out.push(`  prompt version : ${r.promptVersion}`);
  if (!r.blockingActive) {
    out.push('  ⚠ BLOCKING IS OFF — no failure state available, so a repeatedly-failing entry is retried every run.');
  }
  if (r.blocked.length === 0) {
    out.push('  none');
  } else {
    out.push(`  ${r.blocked.length} entry(ies) blocked after ${3} consecutive failures — NOT attempted this run:`);
    for (const b of r.blocked) {
      out.push(`    ${b.locator}  (${b.failures} consecutive failure(s))`);
      out.push(`       last error: ${b.lastError || '(none recorded)'}`);
    }
    out.push('  These will stay blocked until the prompt version or the vocabulary changes.');
  }
  if (r.newlyBlocked.length > 0) {
    out.push(`  ⚠ NEWLY BLOCKED THIS RUN: ${r.newlyBlocked.join(', ')}`);
  }

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

  out.push('', 'LINKS');
  out.push(`  references planned LINKED : ${r.linkedReferencesPlanned}`);
  out.push(`  references planned plain  : ${r.plainReferencesPlanned}${r.plainReferencesPlanned > 0 ? '  ⚠ no linkable heading' : ''}`);
  if (!r.dryRun) {
    // ⚠ BOTH DIMENSIONS. contentVerified true with linkVerified false is a
    // line that reads right and is not clickable.
    out.push(`  links CONFIRMED (content AND link) : ${r.linksConfirmed} of ${r.linkedReferencesPlanned}`);
    if (r.linksConfirmed !== r.linkedReferencesPlanned) {
      out.push(`  ⚠ ${r.linkedReferencesPlanned - r.linksConfirmed} link(s) did NOT confirm on both dimensions`);
    }
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
      out.push(`  [${w.link ? 'LINK' : 'ref '}]   ${w.tabTitle} · ${w.term} · ${w.locator}`);
      out.push(`           after ${JSON.stringify(w.afterLine.slice(0, 90))}`);
      if (w.link) {
        out.push(`           runs  ${JSON.stringify(w.link.prefix)} + [${JSON.stringify(w.link.linkText)}](link) + ${JSON.stringify(w.link.suffix)}`);
        out.push(`           url   ${w.link.url}`);
      } else {
        out.push(`           +     ${JSON.stringify(w.text)}`);
      }
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
