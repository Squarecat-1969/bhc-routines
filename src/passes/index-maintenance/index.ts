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
import type { SheetsClient } from '../../lib/sheets.js';
import {
  PROMPT_VERSION,
  STATE_HEADER,
  STATE_RANGES,
  STATE_TAB_NAME,
  blockDecision,
  nextState,
  parseFailureRow,
  serializeFailureRow,
  type EntryFailureState,
} from './failure-state.js';
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
import {
  headingUrlsByLocator,
  parseIndexTab,
  parseSourceTab,
  type IndexTab,
  type SourceEntry,
} from './parse.js';
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
  /**
   * Optional. Without it the routine still runs, but CANNOT block a repeatedly
   * failing entry — the state has nowhere to live. Reported loudly rather than
   * silently degraded.
   */
  readonly sheets?: SheetsClient;
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
  /** ⚠ Reported BY NAME on every run, whether or not anything else happened. */
  readonly blocked: readonly { locator: string; failures: number; lastError: string }[];
  readonly newlyBlocked: readonly string[];
  readonly blockingActive: boolean;
  readonly promptVersion: string;
  readonly missingFailureClass: readonly string[];
  readonly rejectedTerms: readonly string[];

  readonly planned: readonly PlannedWrite[];
  readonly plannedByTab: Readonly<Record<string, number>>;
  /** CONFIRMED by the route's byte comparison, never the count we intended. */
  readonly writesConfirmed: number;
  readonly writesAttempted: number;
  /** References planned as LINKED (the entry had a usable anchor). */
  readonly linkedReferencesPlanned: number;
  /** References planned as plain because no anchor was available. */
  readonly plainReferencesPlanned: number;
  /**
   * Links whose BOTH dimensions came back true — contentVerified AND
   * linkVerified. Counted separately from writes, because a write can confirm
   * while its link does not.
   */
  readonly linksConfirmed: number;
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
      blocked: [],
      newlyBlocked: [],
      blockingActive: false,
      promptVersion: PROMPT_VERSION,
      missingFailureClass: [],
      rejectedTerms: [],
      planned: [],
      plannedByTab: {},
      writesConfirmed: 0,
      writesAttempted: 0,
      linkedReferencesPlanned: 0,
      plainReferencesPlanned: 0,
      linksConfirmed: 0,
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
    // ⚠ HEADINGS ARE REQUESTED HERE because this is where a link's anchor
    // comes from. The route reports Google's own headingId verbatim and never
    // invents one, and hands back the full URL already assembled.
    const read = await docs.read(src.documentId, src.tabId, true);
    const headingUrls = headingUrlsByLocator(read.headings ?? []);
    const entries = parseSourceTab(read.content, headingUrls);
    const linkable = entries.filter((e) => e.headingUrl !== null).length;
    if (linkable < entries.length) {
      // Not an abort: a reference with no anchor is written PLAIN rather than
      // linked to the wrong place. Reported so it is visible.
      warnings.push(
        `${src.label}: ${entries.length - linkable} of ${entries.length} entries have no linkable heading — ` +
          'their references will be written as plain text',
      );
    }
    if ((read.unlinkableHeadingCount ?? 0) > 0) {
      warnings.push(`${src.label}: ${read.unlinkableHeadingCount} heading(s) carry no Google anchor`);
    }
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
  // --- blocked entries ------------------------------------------------------
  const vocabularySize = vocabulary.owner.size;
  let priorState = new Map<string, EntryFailureState>();
  let blockingActive = false;
  if (opts.sheets) {
    try {
      const rows = await opts.sheets.read(STATE_RANGES.data);
      for (const r of rows) {
        const st = parseFailureRow(r);
        if (st) priorState.set(st.locator, st);
      }
      blockingActive = true;
      logger.info(`  failure state: ${priorState.size} entry(ies) tracked`);
    } catch (error) {
      // ⚠ DEGRADE LOUDLY. Without the tab the routine still indexes, but a
      // repeatedly-failing entry is retried forever — the defect this exists
      // to close. Never silent.
      const msg =
        `${STATE_TAB_NAME} is unreadable (${error instanceof Error ? error.message : String(error)}) — ` +
        `BLOCKING IS OFF this run, so a repeatedly-failing entry will be retried at full cost. ` +
        `Create the tab with header: ${STATE_HEADER.join(', ')}`;
      logger.warn(`  ${msg}`);
      warnings.push(msg);
    }
  } else {
    warnings.push('no Sheets client supplied — BLOCKING IS OFF; a repeatedly-failing entry will be retried every run');
  }

  const blockedNow: { locator: string; failures: number; lastError: string }[] = [];
  const eligible = pending.filter((e) => {
    const d = blockDecision(priorState.get(e.locator), PROMPT_VERSION, vocabularySize);
    if (d.blocked) {
      blockedNow.push({ locator: e.locator, failures: d.failures, lastError: d.lastError });
      return false;
    }
    return true;
  });
  if (blockedNow.length > 0) {
    logger.warn(`  ${blockedNow.length} entry(ies) BLOCKED and skipped — see the report`);
  }

  const cap = opts.maxLlmCalls ?? MAX_LLM_CALLS;
  const toCall = eligible.slice(0, cap);
  if (eligible.length > toCall.length) {
    warnings.push(`LLM cap of ${cap} hit — ${eligible.length - toCall.length} entry(ies) left for the next run`);
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

  // ⚠ RECORD EVERY ATTEMPT'S OUTCOME. A failure that leaves no trace is a
  // failure that gets paid for again next run.
  const newlyBlocked: string[] = [];
  if (blockingActive && opts.sheets && outcomes.length > 0) {
    const updated = new Map(priorState);
    for (const o of outcomes) {
      const next = nextState({
        locator: o.locator,
        prior: priorState.get(o.locator),
        succeeded: o.verdict !== null,
        error: o.error,
        today,
        promptVersion: PROMPT_VERSION,
        vocabularySize,
      });
      const wasBlocked = priorState.get(o.locator)?.blocked ?? false;
      if (next.blocked && !wasBlocked) newlyBlocked.push(o.locator);
      updated.set(o.locator, next);
    }
    if (!dryRun) {
      const rows = [...updated.values()].map(serializeFailureRow);
      const lastRow = 1 + rows.length;
      if (rows.length > 0) await opts.sheets.update(`${STATE_TAB_NAME}!A2:G${lastRow}`, rows);
      logger.info(`  failure state: ${rows.length} row(s) written`);
    } else {
      logger.info(`  DRY RUN — would write ${updated.size} failure-state row(s)`);
    }
    for (const [, st] of updated) {
      if (st.blocked && !blockedNow.some((b) => b.locator === st.locator)) {
        blockedNow.push({ locator: st.locator, failures: st.consecutiveFailures, lastError: st.lastError });
      }
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
  let linksConfirmed = 0;

  if (dryRun) {
    logger.info(`  DRY RUN — nothing written. ${plan.writes.length} write(s) would be sent.`);
  } else {
    for (const w of plan.writes) {
      try {
        const applied = await applyWrite(docs, w);
        writesConfirmed += 1;
        if (applied.linkConfirmed) linksConfirmed += 1;
        writeOutcomes.push({ write: w, verified: true, detail: applied.detail });
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
    const linkedPlanned = plan.writes.filter((w) => w.kind === 'insert-reference' && w.link !== null).length;
    logger.info(`  ${writesConfirmed} of ${plan.writes.length} write(s) CONFIRMED by byte comparison`);
    logger.info(`  ${linksConfirmed} of ${linkedPlanned} link(s) CONFIRMED on BOTH dimensions (contentVerified AND linkVerified)`);
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
    blocked: blockedNow.sort((a, b) => a.locator.localeCompare(b.locator)),
    newlyBlocked,
    blockingActive,
    promptVersion: PROMPT_VERSION,
    missingFailureClass,
    rejectedTerms: [...new Set(outcomes.flatMap((o) => o.rejected))],
    planned: plan.writes,
    plannedByTab,
    writesConfirmed,
    writesAttempted: dryRun ? 0 : plan.writes.length,
    linkedReferencesPlanned: plan.writes.filter((w) => w.kind === 'insert-reference' && w.link !== null).length,
    plainReferencesPlanned: plan.writes.filter((w) => w.kind === 'insert-reference' && w.link === null).length,
    linksConfirmed,
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
async function applyWrite(
  docs: DocsClient,
  w: PlannedWrite,
): Promise<{ detail: string; linkConfirmed: boolean }> {
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
    return { detail: `delta ${res.delta}/${res.expectedDelta}`, linkConfirmed: false };
  }

  const found = await docs.find(INDEX_DOC_ID, w.tabId, w.afterLine);
  if (found.matchCount !== 1) {
    throw new Error(`anchor for "${w.term}" matched ${found.matchCount} times — refusing to write`);
  }
  const at = found.endIndex;

  if (w.kind === 'insert-term' || w.link === null) {
    const res = await docs.insertText({
      documentId: INDEX_DOC_ID,
      tabId: w.tabId,
      // Immediately after the anchor line, before its newline's successor.
      index: at,
      text: `\n${w.text}`,
    });
    return { detail: `delta ${res.delta}/${res.expectedDelta} (plain)`, linkConfirmed: false };
  }

  // ⚠ THREE RUNS, INSERTED IN REVERSE ORDER AT ONE FIXED INDEX.
  //
  // The migrated lines link the `§NNN · DATE · Log` prefix only, leaving the
  // bullet and the quotation outside the link, so the line has to be built
  // from three runs rather than one.
  //
  // Reverse order at a FIXED index buys two things at once, and both are
  // failure modes rather than tidiness:
  //
  //  1. NO INDEX ARITHMETIC. Each insert goes at exactly `at` and pushes what
  //     was already inserted to the right, so no run's position is computed
  //     from another run's length. Document indices count structural
  //     positions as well as characters, so that arithmetic is exactly the
  //     kind that drifts.
  //  2. NO STYLE INHERITANCE. Google Docs inherits formatting from the text
  //     immediately BEFORE an insertion point, and `at` always sits at the end
  //     of the plain anchor line. Inserting forward instead would place the
  //     excerpt directly after the linked run, where it would inherit the link
  //     and swallow the quotation into it.
  const suffix = await docs.insertText({ documentId: INDEX_DOC_ID, tabId: w.tabId, index: at, text: w.link.suffix });
  const link = await docs.insertLink({
    documentId: INDEX_DOC_ID,
    tabId: w.tabId,
    index: at,
    text: w.link.linkText,
    url: w.link.url,
  });
  const prefix = await docs.insertText({
    documentId: INDEX_DOC_ID,
    tabId: w.tabId,
    index: at,
    text: `\n${w.link.prefix}`,
  });
  return {
    detail:
      `linked · content=${String(link.contentVerified)} link=${String(link.linkVerified)} · ` +
      `deltas ${prefix.delta}/${link.delta}/${suffix.delta}`,
    linkConfirmed: link.contentVerified !== false && link.linkVerified === true,
  };
}
