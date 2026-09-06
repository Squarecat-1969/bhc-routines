/**
 * DOCUMENTS QC — checks that each governing document holds what it declares it
 * holds, and that the ToC's link targets still exist.
 *
 * ⚠ READ-ONLY AGAINST EVERY DOCUMENT. There is no insertText, no replaceRange
 * and no insertLink anywhere in this pass, and the DocsClient methods that
 * write are never imported. See manifest.ts for why that is capability rather
 * than caution.
 */

import { DocsClient, type DocHeading } from '../../lib/docs.js';
import type { Logger } from '../../lib/logger.js';
import { INDEX_DOC_ID, SOURCE_TABS } from '../index-maintenance/constants.js';
import { parseIndexTab, parseSourceTab } from '../index-maintenance/parse.js';
import { buildWatermark } from '../index-maintenance/plan.js';
import {
  countBlankHeadings,
  generatedTocLines,
  handAppendedFrom,
  findLogEntryHeadings,
  findLogEntryRefs,
  findStrings,
  headingsMissingFromToc,
  missingByName,
  paragraphHeadings,
  statedBlankHeadingCount,
  tocEntriesWithoutHeading,
  type Finding,
} from './checks.js';
import { RULES, ruleById, type RuleSeverity } from './manifest.js';

export const PLAN_DOC_ID = '1Hx1gXee4cltomMJbb2Z54etg4P1EO8VtRXURiYULDOI';
export const PLAN_TOC_TAB = 't.nkk18fsz2qqi';
export const PLAN_BODY_TAB = 't.6r0bmznlg6id';
export const LOG_001_DOC_ID = '1RuYdyhoaaL8xBfBIdvGoxgJ39gA-nxQaN9qx-I3lFX4';

/** ⚠ Verified live 2026-09-05: log-001 holds these three and nothing else. */
export const LOG_001_EXPECTED_TABS = ['May 2026', 'June 2026', 'July 2026'];

const LOG_DOC_IDS = [
  LOG_001_DOC_ID,
  '1gVUPxKAo19UyQN2isYuqfVuha3i6340gEylsVdX9Snw',
  '1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA',
];
const LOG_TAB_NAMES = ['May 2026', 'June 2026', 'July 2026', 'August 2026', 'September 2026'];

export interface RuleResult {
  readonly ruleId: string;
  readonly statement: string;
  readonly earnedBy: string;
  readonly severity: RuleSeverity;
  readonly document: string;
  readonly fired: boolean;
  readonly findings: readonly Finding[];
  /** What the check actually measured, so a passing rule is not just silence. */
  readonly measured: string;
}

export interface QcReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;
  readonly documentsRead: readonly { label: string; chars: number; headings: number; preReadMs: number }[];
  readonly results: readonly RuleResult[];
  readonly warnings: readonly string[];
  /** ⚠ Proof of the read-only claim, counted rather than asserted. */
  readonly writesIssued: number;
}

export interface QcOptions {
  readonly docs: DocsClient;
  readonly logger: Logger;
  readonly runId?: string;
}

export async function runDocsQc(opts: QcOptions): Promise<QcReport> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? `DOCS-QC-${Date.now()}`;
  try {
    return await runInner(opts, runId, startedAt);
  } catch (error) {
    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      aborted: true,
      abortReason: error instanceof Error ? (error.stack ?? error.message) : String(error),
      documentsRead: [],
      results: [],
      warnings: [],
      writesIssued: 0,
    };
  }
}

async function runInner(opts: QcOptions, runId: string, startedAt: string): Promise<QcReport> {
  const { docs, logger } = opts;
  const warnings: string[] = [];
  const documentsRead: { label: string; chars: number; headings: number; preReadMs: number }[] = [];

  logger.info('DOCUMENTS QC — read-only');

  const read = async (label: string, documentId: string, tabId: string, headings = false) => {
    // ⚠ tabId is REQUIRED. A read without one silently resolves to the first tab.
    const r = await docs.read(documentId, tabId, headings);
    documentsRead.push({ label, chars: r.charCount, headings: r.headingCount ?? 0, preReadMs: r.preReadMs });
    logger.info(`  ${label.padEnd(28)} ${String(r.charCount).padStart(7)} chars · ${r.headingCount ?? 0} headings · ${r.preReadMs}ms`);
    return r;
  };

  const toc = await read("Plan · Table of Contents", PLAN_DOC_ID, PLAN_TOC_TAB, true);
  const plan = await read('Plan · body', PLAN_DOC_ID, PLAN_BODY_TAB, true);
  const planHeadings: readonly DocHeading[] = plan.headings ?? [];

  // Index tabs, for coverage and self-reference.
  const indexTabs = await docs.listTabs(INDEX_DOC_ID);
  let indexContent = '';
  const parsedIndexTabs = [];
  for (const t of indexTabs) {
    const r = await read(`Index · ${t.title}`, INDEX_DOC_ID, t.tabId);
    indexContent += `\n${r.content}`;
    if (t.title !== 'SOURCES INDEXED') parsedIndexTabs.push(parseIndexTab(t.tabId, t.title, r.content));
  }

  // Every Log entry, for coverage.
  const logLocators: string[] = [];
  for (const src of SOURCE_TABS) {
    if (src.label === "Developer's Plan") continue;
    const r = await read(src.label, src.documentId, src.tabId);
    for (const e of parseSourceTab(r.content)) logLocators.push(e.locator);
  }

  const log001Tabs = (await docs.listTabs(LOG_001_DOC_ID)).map((t) => t.title);

  // --- run the rules ---------------------------------------------------------
  const results: RuleResult[] = [];
  const emit = (ruleId: string, findings: readonly Finding[], measured: string): void => {
    const rule = ruleById(ruleId);
    results.push({
      ruleId: rule.id,
      statement: rule.statement,
      earnedBy: rule.earnedBy,
      severity: rule.severity,
      document: rule.document,
      fired: findings.length > 0,
      findings,
      measured,
    });
  };

  emit(
    'toc-no-log-doc-id',
    findStrings(toc.content, LOG_DOC_IDS, 'toc-no-log-doc-id'),
    `${LOG_DOC_IDS.length} log document ID(s) searched for across ${toc.content.split('\n').length} ToC lines`,
  );
  emit(
    'toc-no-log-tab-name',
    findStrings(toc.content, LOG_TAB_NAMES, 'toc-no-log-tab-name'),
    `${LOG_TAB_NAMES.length} log tab name(s) searched for`,
  );
  emit(
    'toc-no-log-entry-ref',
    findLogEntryRefs(toc.content),
    `${toc.content.split('\n').length} ToC lines scanned for §NNN`,
  );
  emit(
    'plan-no-log-entries',
    findLogEntryHeadings(planHeadings),
    `${planHeadings.length} Plan headings scanned`,
  );
  emit(
    'index-no-self-reference',
    findStrings(indexContent, [INDEX_DOC_ID], 'index-no-self-reference'),
    `${indexTabs.length} index tabs scanned for the index's own document ID`,
  );

  const unexpectedTabs = log001Tabs.filter((t) => !LOG_001_EXPECTED_TABS.includes(t));
  const missingTabs = LOG_001_EXPECTED_TABS.filter((t) => !log001Tabs.includes(t));
  emit(
    'log-001-tab-inventory',
    [
      ...unexpectedTabs.map((t) => ({ ruleId: 'log-001-tab-inventory', detail: `unexpected tab: ${t}` })),
      ...missingTabs.map((t) => ({ ruleId: 'log-001-tab-inventory', detail: `missing tab: ${t}` })),
    ],
    `log-001 holds: ${log001Tabs.join(', ')}`,
  );

  const orphanEntries = tocEntriesWithoutHeading(toc.content, planHeadings);
  const cut = handAppendedFrom(toc.content);
  const totalLines = toc.content.split('\n').length;
  const excluded = cut === null ? 0 : totalLines - cut;
  if (excluded > 0) {
    // Reported, so the exclusion is visible rather than silent.
    logger.info(`  ToC: ${excluded} trailing line(s) excluded — the block the ToC itself marks "not re-generated from live headings"`);
  }
  emit(
    'toc-entry-resolves-to-heading',
    orphanEntries,
    `${generatedTocLines(toc.content).filter((l) => l.line.trim() !== '').length} generated ToC lines checked ` +
      `(${excluded} hand-appended line(s) excluded, per the ToC's own marker), ` +
      `${planHeadings.filter((h) => h.text.trim() !== '').length} non-blank Plan headings`,
  );

  emit(
    'toc-covers-plan-headings',
    headingsMissingFromToc(toc.content, planHeadings),
    `${planHeadings.filter((h) => (h.level === 1 || h.level === 2) && h.text.trim() !== '').length} non-blank ` +
      'level-1/2 Plan headings compared against the ToC',
  );

  const stated = statedBlankHeadingCount(toc.content);
  const actualBlank = countBlankHeadings(planHeadings);
  if (stated === null) {
    warnings.push("the ToC no longer states a blank-heading count — the recorded-figure check could not run");
    emit('toc-blank-heading-count', [], 'the ToC states no blank-heading count');
  } else {
    emit(
      'toc-blank-heading-count',
      stated.stated === actualBlank
        ? []
        : [{ ruleId: 'toc-blank-heading-count', detail: `ToC says ${stated.stated} ("${stated.sentence}"), Plan tab has ${actualBlank}` }],
      `ToC states ${stated.stated}; measured ${actualBlank}`,
    );
  }

  const covered = buildWatermark(parsedIndexTabs);
  emit(
    'index-covers-log-entries',
    missingByName([...new Set(logLocators)].sort(), covered, 'index-covers-log-entries'),
    `${new Set(logLocators).size} log entries, ${covered.size} locators referenced by the index`,
  );

  const planHeadingTexts = planHeadings.filter((h) => h.text.trim() !== '').map((h) => h.text.trim());
  const indexPlanRefs = new Set(
    parsedIndexTabs
      .flatMap((t) => t.terms.flatMap((x) => x.references))
      .filter((r) => r.source === 'Plan')
      .map((r) => r.locator),
  );
  emit(
    'index-covers-plan-headings',
    planHeadingTexts
      .filter((t) => ![...indexPlanRefs].some((r) => t.startsWith(r) || t.toLowerCase().includes(r.toLowerCase())))
      .map((t) => ({ ruleId: 'index-covers-plan-headings', detail: t.slice(0, 110) })),
    `${planHeadingTexts.length} non-blank Plan headings, ${indexPlanRefs.size} distinct Plan locators in the index`,
  );

  emit(
    'plan-paragraph-headings',
    paragraphHeadings(planHeadings),
    `${planHeadings.length} Plan headings measured against a 120-character threshold`,
  );

  // Every rule in the manifest must have produced a result — a rule that
  // silently never runs is worse than one that fires wrongly.
  const unrun = RULES.filter((r) => !results.some((x) => x.ruleId === r.id));
  if (unrun.length > 0) {
    warnings.push(`RULES DECLARED BUT NEVER RUN: ${unrun.map((r) => r.id).join(', ')}`);
  }

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    documentsRead,
    results,
    warnings,
    // Read-only, counted rather than asserted: this pass never calls a write.
    writesIssued: 0,
  };
}
