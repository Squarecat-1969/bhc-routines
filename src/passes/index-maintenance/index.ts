/**
 * INDEX MAINTENANCE — keeps the keyword index's COVERAGE current.
 *
 * Its links were fixed on 2026-08-30; its coverage was not, and those are
 * different properties. A stale index fails silently and in the worst
 * direction: a search returning nothing reads as "this was never discussed"
 * when it means "this was never indexed."
 *
 * ORDER, and why (Shared Bridge Contract §4):
 *   1. Read every source and the whole index FIRST. Compute the complete set
 *      of changes before writing anything — a job that interleaves reads and
 *      writes across several documents has no coherent state to resume from
 *      when the budget exhausts mid-run.
 *   2. Watermark against the index itself, so only unindexed entries are
 *      judged. Without it every run re-judges the corpus at real cost.
 *   3. One narrow LLM call per unindexed entry.
 *   4. Write: insert reference lines, then update counts.
 *
 * ⚠ IT CANNOT REGENERATE THE INDEX. Not by rule — structurally. The transport
 * offers no wholesale-replacement action (§105, verified by rejection test),
 * `PlannedWrite` cannot express one, and the index holds a controlled
 * vocabulary, a match-modes section and two records of things searched for and
 * NOT found that exist in no source. A regeneration would rebuild the cheap
 * half and destroy the expensive half.
 *
 * ⚠ NOTHING IS ESCAPED. See src/lib/docs.ts — this route writes literal bytes.
 */

import type { AnthropicClient } from '../../lib/anthropic.js';
import type { DocsClient } from '../../lib/docs.js';
import type { Logger } from '../../lib/logger.js';
import { sleep } from '../../lib/http.js';
import {
  ADDITIONAL_TERMS_TAB,
  EXCERPT_CHARS,
  FAILURE_CLASSES_TAB,
  INDEX_DOC_ID,
  LLM_CONCURRENCY,
  LLM_WAVE_PAUSE_MS,
  MAX_LLM_CALLS,
  SOURCES_INDEXED_TAB,
  SOURCE_TABS,
  makeIndexRunId,
  type SourceTab,
} from './constants.js';
import { assignTerms, type AssignmentOutcome } from './llm.js';
import { parseIndexTab, parseSourceTab, type IndexTab, type SourceEntry } from './parse.js';
import {
  buildVocabulary,
  buildWatermark,
  planWrites,
  unindexedEntries,
  type PlannedWrite,
} from './plan.js';

export interface IndexMaintenanceOptions {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly docs: DocsClient;
  readonly anthropic?: AnthropicClient;
  readonly logger: Logger;
  /** Restrict to one source tab. The first live run indexes ONE tab, not the backlog. */
  readonly sourceLabels?: readonly string[];
  readonly maxLlmCalls?: number;
  readonly today?: string;
  /**
   * ⚠ RECOVERY ONLY. Re-judge entries the index already references.
   *
   * The watermark exists so a run does not re-judge the corpus at real cost.
   * The one case it gets wrong is a PARTIALLY indexed entry: after the
   * 2026-09-05 partial run, entries whose reference landed under one term but
   * failed under three others are in the watermark and would never be
   * completed. The per-term "already referenced" check keeps the re-run
   * idempotent — it adds only what is missing.
   */
  readonly ignoreWatermark?: boolean;
}

export interface WriteOutcome {
  readonly write: PlannedWrite;
  readonly verified: boolean;
  readonly detail: string;
}

export interface IndexMaintenanceReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly sourcesRead: readonly { label: string; chars: number; preReadMs: number; entries: number }[];
  readonly indexTabsRead: readonly { title: string; chars: number; terms: number; references: number }[];
  readonly vocabularySize: number;
  readonly duplicateTerms: readonly string[];

  readonly watermarkSize: number;
  readonly unindexed: readonly string[];
  readonly llmCallsMade: number;
  readonly llmFailures: number;
  readonly missingFailureClass: readonly string[];
  readonly rejectedTerms: readonly string[];

  readonly planned: readonly PlannedWrite[];
  readonly plannedByTab: Readonly<Record<string, number>>;
  /** CONFIRMED by the route's byte comparison, never the count we intended. */
  readonly writesConfirmed: number;
  readonly writesAttempted: number;
  readonly outcomes: readonly WriteOutcome[];
  readonly warnings: readonly string[];
}

class AbortRun extends Error {}

export async function runIndexMaintenance(opts: IndexMaintenanceOptions): Promise<IndexMaintenanceReport> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeIndexRunId();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  try {
    return await runInner({ ...opts, runId, today, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    opts.logger.error(`Index maintenance aborted: ${message}`);
    return {
      runId,
      dryRun: opts.dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      aborted: true,
      abortReason: error instanceof AbortRun ? error.message : message,
      sourcesRead: [],
      indexTabsRead: [],
      vocabularySize: 0,
      duplicateTerms: [],
      watermarkSize: 0,
      unindexed: [],
      llmCallsMade: 0,
      llmFailures: 0,
      missingFailureClass: [],
      rejectedTerms: [],
      planned: [],
      plannedByTab: {},
      writesConfirmed: 0,
      writesAttempted: 0,
      outcomes: [],
      warnings: [],
    };
  }
}

async function runInner(
  opts: IndexMaintenanceOptions & { runId: string; today: string; startedAt: string },
): Promise<IndexMaintenanceReport> {
  const { docs, logger, dryRun, runId, today, startedAt } = opts;
  const warnings: string[] = [];

  logger.info('INDEX MAINTENANCE');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);

  // --- STEP 0 — the transport's own contract, checked rather than assumed.
  const health = await docs.health();
  const literalNote = String(health['literalTextNote'] ?? '');
  if (!/no escaping is needed/i.test(literalNote)) {
    // ⚠ IF THIS EVER FIRES, STOP. Every write below sends raw bytes because
    // the route promises not to render markdown. If that promise changes,
    // `bhc_contact_id` starts losing underscores to emphasis parsing and the
    // envelope still reports verified — §098's exact failure.
    throw new AbortRun(
      'THE TRANSPORT NO LONGER PROMISES LITERAL WRITES. This routine sends unescaped identifiers ' +
        `(bhc_contact_id, last_email_interaction) on that promise. health.literalTextNote said: "${literalNote}". ` +
        'Re-read docs/shared-bridge-contract.md Rule 6 before changing the escaping decision.',
    );
  }
  logger.info(`  transport: literal writes confirmed · budget ${String(health['budgetMs'])}ms`);

  // --- STEP 1 — read the index in full.
  logger.info('STEP 1 — reading the index');
  const tabs = await docs.listTabs(INDEX_DOC_ID);
  const indexTabs: IndexTab[] = [];
  const indexTabsRead: { title: string; chars: number; terms: number; references: number }[] = [];

  for (const tab of tabs) {
    if (tab.tabId === SOURCES_INDEXED_TAB) continue; // not a term tab
    const read = await docs.read(INDEX_DOC_ID, tab.tabId);
    const parsed = parseIndexTab(tab.tabId, tab.title, read.content);
    indexTabs.push(parsed);
    const refs = parsed.terms.reduce((a, t) => a + t.references.length, 0);
    indexTabsRead.push({ title: tab.title, chars: read.charCount, terms: parsed.terms.length, references: refs });
    logger.info(`  ${tab.title.padEnd(30)} ${String(read.charCount).padStart(7)} chars · ${parsed.terms.length} terms · ${refs} refs`);
  }

  const groupTabs = indexTabs.filter((t) => t.title.startsWith('GROUP:'));
  const vocabulary = buildVocabulary(groupTabs);
  if (vocabulary.owner.size === 0) {
    // The same shape as an empty suppression index elsewhere in this repo: a
    // parser that silently matches nothing looks exactly like an empty
    // vocabulary, and would re-propose the entire controlled vocabulary as new.
    throw new AbortRun(
      'THE CONTROLLED VOCABULARY PARSED AS EMPTY — every term would be re-proposed as new. ' +
        'The term-header format has changed; check for the trailing space on high-frequency headers.',
    );
  }
  logger.info(`  controlled vocabulary: ${vocabulary.owner.size} term(s) across ${groupTabs.length} GROUP tab(s)`);
  if (vocabulary.duplicates.length > 0) {
    warnings.push(`term(s) defined in more than one GROUP tab: ${vocabulary.duplicates.join(', ')}`);
  }

  const watermark = buildWatermark(indexTabs);
  logger.info(`  watermark: ${watermark.size} entry locator(s) already indexed`);

  // --- STEP 2 — read the sources.
  const selected = selectSources(opts.sourceLabels);
  logger.info(`STEP 2 — reading ${selected.length} source tab(s)`);
  const sourcesRead: { label: string; chars: number; preReadMs: number; entries: number }[] = [];
  const allEntries: SourceEntry[] = [];

  for (const src of selected) {
    const read = await docs.read(src.documentId, src.tabId);
    const entries = parseSourceTab(read.content);
    allEntries.push(...entries);
    sourcesRead.push({ label: src.label, chars: read.charCount, preReadMs: read.preReadMs, entries: entries.length });
    const drift = read.preReadMs / Math.max(1, src.measuredPreReadMs);
    logger.info(
      `  ${src.label.padEnd(28)} ${String(read.charCount).padStart(7)} chars · ${entries.length} entries · ` +
        `preRead ${read.preReadMs}ms (measured ${src.measuredPreReadMs}ms on ${src.measuredOn}, ${drift.toFixed(1)}x)`,
    );
    if (drift > 2) {
      // Rule 8: a measurement is not a law. §105 already caught log-002
      // drifting 6,477 -> 8,500ms between two consecutive days.
      warnings.push(
        `${src.label} preRead was ${read.preReadMs}ms against a measured ${src.measuredPreReadMs}ms ` +
          `(${drift.toFixed(1)}x) — re-measure before relying on the budget for this document`,
      );
    }
  }

  const pending = opts.ignoreWatermark ? [...allEntries] : unindexedEntries(allEntries, watermark);
  if (opts.ignoreWatermark) {
    warnings.push(
      'RECOVERY MODE: the watermark was ignored, so every entry in the selected source was re-judged at full ' +
        'LLM cost. Idempotency still holds — a reference that already exists is not written again.',
    );
  }
  logger.info(`  ${pending.length} of ${allEntries.length} entries are unindexed`);
  if (pending.length === 0) {
    logger.info('  nothing to do — the index already covers every entry in the selected source(s)');
  }

  // --- STEP 3 — one narrow call per entry.
  const groupTitles = new Map(indexTabs.map((t) => [t.tabId, t.title]));
  const failureClassTerms = new Set(
    (indexTabs.find((t) => t.tabId === FAILURE_CLASSES_TAB)?.terms ?? []).map((t) => t.term),
  );
  const cap = opts.maxLlmCalls ?? MAX_LLM_CALLS;
  const toCall = pending.slice(0, cap);
  if (pending.length > toCall.length) {
    warnings.push(`LLM cap of ${cap} hit — ${pending.length - toCall.length} entry(ies) left for the next run`);
  }

  const outcomes: AssignmentOutcome[] = [];
  if (!opts.anthropic) {
    logger.info(`STEP 3 — skipped (no Anthropic client). ${toCall.length} entry(ies) would be assigned.`);
    if (toCall.length > 0) warnings.push(`STEP 3 skipped — ${toCall.length} entry(ies) were not assigned, so nothing can be planned`);
  } else {
    logger.info(`STEP 3 — ${toCall.length} narrow LLM call(s), one per entry`);
    for (let i = 0; i < toCall.length; i += LLM_CONCURRENCY) {
      const wave = toCall.slice(i, i + LLM_CONCURRENCY);
      const results = await Promise.all(
        wave.map((entry) =>
          assignTerms(opts.anthropic!, { entry, vocabulary, groupTitles, failureClassTerms }),
        ),
      );
      outcomes.push(...results);
      for (const r of results) {
        if (r.error) logger.warn(`  ${r.locator}: ${r.error}`);
        else logger.info(`  ${r.locator} → ${r.verdict!.terms.join(', ') || '(none)'}${r.verdict!.proposedTerms.length ? ` · proposed: ${r.verdict!.proposedTerms.join(', ')}` : ''}`);
      }
      if (i + LLM_CONCURRENCY < toCall.length) await sleep(LLM_WAVE_PAUSE_MS);
    }
  }

  const byLocator = new Map(toCall.map((e) => [e.locator, e]));
  const assignments = outcomes
    .filter((o) => o.verdict !== null)
    .map((o) => ({
      entry: byLocator.get(o.locator)!,
      terms: o.verdict!.terms,
      proposedTerms: o.verdict!.proposedTerms,
    }));

  const missingFailureClass = outcomes.filter((o) => o.verdict && o.missingFailureClass).map((o) => o.locator);
  if (missingFailureClass.length > 0) {
    // §089.4, locked and still governing. Reported, not enforced — only a
    // human can say whether an entry describes an incident.
    warnings.push(
      `${missingFailureClass.length} entry(ies) got no failure-class term: ${missingFailureClass.join(', ')}. ` +
        '§089.4 makes one mandatory on any entry describing an incident, bug or correction — check these.',
    );
  }

  // --- STEP 4 — plan.
  const tabsById = new Map(indexTabs.map((t) => [t.tabId, t]));
  const plan = planWrites({
    assignments,
    vocabulary,
    tabsById,
    additionalTermsTabId: ADDITIONAL_TERMS_TAB,
    today,
    excerptChars: EXCERPT_CHARS,
  });
  warnings.push(...plan.warnings);

  const plannedByTab: Record<string, number> = {};
  for (const w of plan.writes) plannedByTab[w.tabTitle] = (plannedByTab[w.tabTitle] ?? 0) + 1;

  logger.info(`STEP 4 — ${plan.writes.length} write(s) planned`);
  for (const [tab, n] of Object.entries(plannedByTab)) logger.info(`  ${String(n).padStart(4, ' ')}  ${tab}`);

  // --- STEP 5 — write.
  const writeOutcomes: WriteOutcome[] = [];
  let writesConfirmed = 0;

  if (dryRun) {
    logger.info(`  DRY RUN — nothing written. ${plan.writes.length} write(s) would be sent.`);
  } else {
    for (const w of plan.writes) {
      try {
        const detail = await applyWrite(docs, w);
        writesConfirmed += 1;
        writeOutcomes.push({ write: w, verified: true, detail });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeOutcomes.push({ write: w, verified: false, detail: message });
        // ⚠ ON PARTIAL COMPLETION, SAY WHICH LANDED (contract §4). The run
        // continues so the report is complete rather than stopping at the
        // first failure with an unknown tail.
        warnings.push(`write FAILED (${w.kind} · ${w.tabTitle} · ${w.term}): ${message}`);
        logger.warn(`  FAILED ${w.kind} ${w.term}: ${message}`);
      }
    }
    logger.info(`  ${writesConfirmed} of ${plan.writes.length} write(s) CONFIRMED by byte comparison`);
  }

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    sourcesRead,
    indexTabsRead,
    vocabularySize: vocabulary.owner.size,
    duplicateTerms: vocabulary.duplicates,
    watermarkSize: watermark.size,
    unindexed: pending.map((e) => e.locator),
    llmCallsMade: outcomes.length,
    llmFailures: outcomes.filter((o) => o.error !== null).length,
    missingFailureClass,
    rejectedTerms: [...new Set(outcomes.flatMap((o) => o.rejected))],
    planned: plan.writes,
    plannedByTab,
    writesConfirmed,
    writesAttempted: dryRun ? 0 : plan.writes.length,
    outcomes: writeOutcomes,
    warnings,
  };
}

function selectSources(labels: readonly string[] | undefined): readonly SourceTab[] {
  if (!labels || labels.length === 0) return SOURCE_TABS;
  const chosen = SOURCE_TABS.filter((s) => labels.includes(s.label));
  if (chosen.length !== labels.length) {
    // Rule 3: an unrecognised identifier enumerates the valid ones.
    throw new AbortRun(
      `unknown source label(s). Valid labels: ${SOURCE_TABS.map((s) => s.label).join(' | ')}`,
    );
  }
  return chosen;
}

/**
 * Apply one planned write.
 *
 * ⚠ THE ANCHOR IS LOCATED WITH `find` IMMEDIATELY BEFORE THE WRITE, and its
 * DOCUMENT index is used — never `plainTextStartIndex`. Phase 1 shipped the
 * plain-text offsets under the document-index names and a caller substituting
 * one for the other writes to the wrong place with every parameter matching.
 *
 * ⚠ THE ANCHOR TEXT IS COPIED FROM A READ, NEVER RETYPED. Every `afterLine`
 * and `fromLine` on a PlannedWrite came out of `parseIndexTab`, so the curly
 * quotes in it are the document's own.
 */
async function applyWrite(docs: DocsClient, w: PlannedWrite): Promise<string> {
  if (w.kind === 'update-count') {
    const found = await docs.find(INDEX_DOC_ID, w.tabId, w.fromLine);
    if (found.matchCount !== 1) {
      throw new Error(`anchor for "${w.term}" matched ${found.matchCount} times — refusing to write`);
    }
    const res = await docs.replaceRange({
      documentId: INDEX_DOC_ID,
      tabId: w.tabId,
      startIndex: found.startIndex,
      endIndex: found.endIndex,
      text: w.toLine,
      expectedStartsWith: w.fromLine.slice(0, 12),
      expectedEndsWith: w.fromLine.slice(-8),
    });
    return `delta ${res.delta}/${res.expectedDelta}`;
  }

  const found = await docs.find(INDEX_DOC_ID, w.tabId, w.afterLine);
  if (found.matchCount !== 1) {
    throw new Error(`anchor for "${w.term}" matched ${found.matchCount} times — refusing to write`);
  }
  const res = await docs.insertText({
    documentId: INDEX_DOC_ID,
    tabId: w.tabId,
    // Immediately after the anchor line, before its newline's successor.
    index: found.endIndex,
    text: `\n${w.text}`,
  });
  return `delta ${res.delta}/${res.expectedDelta}`;
}
