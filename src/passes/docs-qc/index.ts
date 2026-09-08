/**
 * DOCUMENTS QC — checks that each governing document holds what it declares it
 * holds, and that the ToC's link targets still exist.
 *
 * ⚠ READ-ONLY AGAINST EVERY DOCUMENT. There is no insertText, no replaceRange
 * and no insertLink anywhere in this pass, and the DocsClient methods that
 * write are never imported. See manifest.ts for why that is capability rather
 * than caution.
 */

import { DocsClient, anchorOf, type DocHeading, type DocLink } from '../../lib/docs.js';
import type { SheetsClient } from '../../lib/sheets.js';
import { PLAN_STATE_RANGES, parsePlanStateRow } from '../index-maintenance/plan-state.js';
import type { Logger } from '../../lib/logger.js';
import { INDEX_DOC_ID, SOURCE_TABS } from '../index-maintenance/constants.js';
import { parseIndexTab, parseSourceTab, planLocatorMatches } from '../index-maintenance/parse.js';
import { buildWatermark } from '../index-maintenance/plan.js';
import {
  countBlankHeadings,
  generatedTocLines,
  handAppendedFrom,
  findLogEntryHeadings,
  findLogEntryRanges,
  findStrings,
  headingsMissingFromToc,
  missingByName,
  paragraphHeadings,
  statedBlankHeadingCount,
  linksWithDeadAnchors,
  tocEntriesWithoutHeading,
  type Finding,
} from './checks.js';
import { RULES, ruleById, type Rule, type RuleSeverity } from './manifest.js';

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
  /**
   * ⚠ WHY A RULE PASSED — SET WHEN IT DID NOT RUN AT ALL.
   *
   * `toc-blank-heading-count` rendered a green PASS on 2026-09-08 because the
   * ToC no longer states a count, so there was nothing to compare. A warning
   * was emitted, but the rule's own line said the opposite of what happened:
   * the manifest's stated failure mode, happening to a rule inside the
   * manifest. A rule that cannot run is NOT a rule that passed.
   */
  readonly notRun: string | null;
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
  /**
   * ⚠ THE ONE CROSS-STORE DEPENDENCY IN AN OTHERWISE DOCS-ONLY PASS, and it is
   * optional. Without it `plan-section-unindexed` cannot run, because the set
   * of tracked sections lives in Sheets. That is REPORTED LOUDLY rather than
   * silently skipped: a rule that vanishes when its dependency is missing is
   * indistinguishable from a rule that passed.
   */
  readonly sheets?: SheetsClient;
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

  const read = async (label: string, documentId: string, tabId: string, headings = false, links = false) => {
    // ⚠ tabId is REQUIRED. A read without one silently resolves to the first tab.
    const r = await docs.read(documentId, tabId, headings, links);
    documentsRead.push({ label, chars: r.charCount, headings: r.headingCount ?? 0, preReadMs: r.preReadMs });
    logger.info(`  ${label.padEnd(28)} ${String(r.charCount).padStart(7)} chars · ${r.headingCount ?? 0} headings · ${r.preReadMs}ms`);
    return r;
  };

  const toc = await read("Plan · Table of Contents", PLAN_DOC_ID, PLAN_TOC_TAB, true);
  const plan = await read('Plan · body', PLAN_DOC_ID, PLAN_BODY_TAB, true);
  const planHeadings: readonly DocHeading[] = plan.headings ?? [];

  // Index tabs, for coverage and self-reference.
  const indexTabs = await docs.listTabs(INDEX_DOC_ID);
  // ⚠ ANCHORS, NOT TEXT. Collected per source document so a link can be
  // resolved against the document it actually points into.
  const anchorsByDocument = new Map<string, Set<string>>();
  const addAnchors = (documentId: string, hs: readonly DocHeading[]): void => {
    const set = anchorsByDocument.get(documentId) ?? new Set<string>();
    for (const h of hs) if (h.headingId) set.add(h.headingId);
    anchorsByDocument.set(documentId, set);
  };
  addAnchors(PLAN_DOC_ID, planHeadings);
  addAnchors(PLAN_DOC_ID, toc.headings ?? []);
  const indexLinkTabs: { title: string; links: readonly DocLink[] }[] = [];
  const linkForms: Record<string, number> = {};
  let indexContent = '';
  const parsedIndexTabs = [];
  for (const t of indexTabs) {
    // ⚠ HEADINGS TOO. The SOURCES INDEXED tab links into the index's own tabs,
    // so the index is one of the documents an index link may legitimately
    // resolve into. Omitting its anchors reported eight live links as pointing
    // at an UNKNOWN DOCUMENT — the check being wrong, not the document.
    const r = await read(`Index · ${t.title}`, INDEX_DOC_ID, t.tabId, true, true);
    addAnchors(INDEX_DOC_ID, r.headings ?? []);
    indexContent += `\n${r.content}`;
    indexLinkTabs.push({ title: t.title, links: r.links ?? [] });
    for (const [form, n] of Object.entries(r.linkForms ?? {})) linkForms[form] = (linkForms[form] ?? 0) + n;
    if (t.title !== 'SOURCES INDEXED') parsedIndexTabs.push(parseIndexTab(t.tabId, t.title, r.content));
  }

  // Every Log entry, for coverage.
  const logLocators: string[] = [];
  for (const src of SOURCE_TABS) {
    if (src.label === "Developer's Plan") continue;
    const r = await read(src.label, src.documentId, src.tabId, true);
    addAnchors(src.documentId, r.headings ?? []);
    for (const e of parseSourceTab(r.content)) logLocators.push(e.locator);
  }

  const log001Tabs = (await docs.listTabs(LOG_001_DOC_ID)).map((t) => t.title);

  // --- run the rules ---------------------------------------------------------
  const results: RuleResult[] = [];
  /**
   * ⚠ `notRun` IS A REASON STRING, NOT A BOOLEAN, and every rule whose input
   * can be absent passes one. Audited 2026-09-08: every rule below reads
   * something that a transport change could return empty — Plan headings, ToC
   * lines, index links, log locators, the tracked set — and in every case an
   * empty input yields zero findings, which renders as a pass. That is the
   * wrong-zero this codebase has now met four times.
   */
  const emit = (ruleId: string, findings: readonly Finding[], measured: string, notRun: string | null = null): void => {
    if (notRun) warnings.push(`${ruleId} DID NOT RUN — ${notRun}`);
    results.push(buildRuleResult(ruleById(ruleId), findings, measured, notRun));
  };

  // --- preconditions, one per input a rule depends on ------------------------
  const noPlanHeadings = planHeadings.length === 0 ? 'the Plan tab returned no headings — includeHeadings gave nothing to check' : null;
  const tocLineCount = toc.content.split('\n').filter((l) => l.trim() !== '').length;
  const noTocLines = tocLineCount === 0 ? 'the ToC returned no content' : null;
  const noIndexContent = indexContent.trim() === '' ? 'no index tab returned any content' : null;
  const noLogLocators = logLocators.length === 0 ? 'no §NNN entry was parsed from any log tab' : null;


  emit(
    'toc-no-log-doc-id',
    findStrings(toc.content, LOG_DOC_IDS, 'toc-no-log-doc-id'),
    `${LOG_DOC_IDS.length} log document ID(s) searched for across ${toc.content.split('\n').length} ToC lines`,
    noTocLines,
  );
  emit(
    'toc-no-log-tab-name',
    findStrings(toc.content, LOG_TAB_NAMES, 'toc-no-log-tab-name'),
    `${LOG_TAB_NAMES.length} log tab name(s) searched for`,
    noTocLines,
  );
  emit(
    'toc-no-log-entry-range',
    findLogEntryRanges(toc.content),
    `${toc.content.split('\n').length} ToC lines scanned for a §NNN range ` +
      '(a single §NNN citation is allowed — see the manifest for why)',
    noTocLines,
  );
  emit(
    'plan-no-log-entries',
    findLogEntryHeadings(planHeadings),
    `${planHeadings.length} Plan headings scanned`,
    noPlanHeadings,
  );
  emit(
    'index-no-self-reference',
    findStrings(indexContent, [INDEX_DOC_ID], 'index-no-self-reference'),
    `${indexTabs.length} index tabs scanned for the index's own document ID`,
    indexTabs.length === 0 ? 'listTabs returned no index tabs' : noIndexContent,
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
    log001Tabs.length === 0 ? 'listTabs returned no tabs for log-001' : null,
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
    noPlanHeadings ?? noTocLines,
  );

  // ⚠ BY ANCHOR, NEVER BY TEXT. See linksWithDeadAnchors — INCIDENT 2 passes
  // the text-based rule above while its link points nowhere.
  const deadLinks = indexLinkTabs.flatMap((t) =>
    linksWithDeadAnchors({
      tabTitle: t.title,
      links: t.links,
      anchorsByDocument,
      ownDocumentId: INDEX_DOC_ID,
      ruleId: 'index-link-targets-resolve',
    }),
  );
  emit(
    'index-link-targets-resolve',
    deadLinks,
    `${indexLinkTabs.reduce((n, t) => n + t.links.length, 0)} index link(s) resolved by anchor ID across ` +
      `${anchorsByDocument.size} document(s); link forms seen: ${JSON.stringify(linkForms)}`,
    // ⚠ THE WRONG ZERO, GUARDED. If includeLinks ever stops returning links,
    // every anchor resolves vacuously and this rule reports a clean pass over
    // an unchecked index. A zero here has twice been read as a finding.
    indexLinkTabs.reduce((n, t) => n + t.links.length, 0) === 0
      ? 'no index tab returned any links — includeLinks gave nothing to resolve'
      : null,
  );

  emit(
    'toc-covers-plan-headings',
    headingsMissingFromToc(toc.content, planHeadings),
    `${planHeadings.filter((h) => (h.level === 1 || h.level === 2) && h.text.trim() !== '').length} non-blank ` +
      'level-1/2 Plan headings compared against the ToC',
    noPlanHeadings ?? noTocLines,
  );

  const stated = statedBlankHeadingCount(toc.content);
  const actualBlank = countBlankHeadings(planHeadings);
  if (stated === null) {
    // ⚠ THE RULE THAT EARNED `notRun`. This rendered a green PASS.
    emit(
      'toc-blank-heading-count',
      [],
      'nothing to compare — the ToC states no blank-heading count',
      'the ToC no longer states a blank-heading count, so there is no recorded figure to check',
    );
  } else {
    emit(
      'toc-blank-heading-count',
      stated.stated === actualBlank
        ? []
        : [{ ruleId: 'toc-blank-heading-count', detail: `ToC says ${stated.stated} ("${stated.sentence}"), Plan tab has ${actualBlank}` }],
      `ToC states ${stated.stated}; measured ${actualBlank}`,
      noPlanHeadings,
    );
  }

  const covered = buildWatermark(parsedIndexTabs);
  emit(
    'index-covers-log-entries',
    missingByName([...new Set(logLocators)].sort(), covered, 'index-covers-log-entries'),
    `${new Set(logLocators).size} log entries, ${covered.size} locators referenced by the index`,
    noLogLocators ?? noIndexContent,
  );

  const planHeadingTexts = planHeadings.filter((h) => h.text.trim() !== '').map((h) => h.text.trim());
  const indexPlanRefs = new Set(
    parsedIndexTabs
      .flatMap((t) => t.terms.flatMap((x) => x.references))
      .filter((r) => r.source === 'Plan')
      .map((r) => r.locator),
  );
  // ⚠ TRACKED SECTIONS NOTHING POINTS AT. Derived from THE INDEX, never from
  // the state tab's own indexed_by column — a column that says `unindexed` is
  // reporting what it was told, not what is true.
  const tracked: { locator: string; headingId: string; liveAnchor: string }[] = [];
  let planStateReadable = false;
  if (opts.sheets) {
    try {
      for (const row of await opts.sheets.read(PLAN_STATE_RANGES.data)) {
        const st = parsePlanStateRow(row);
        if (st) tracked.push({ locator: st.locator, headingId: st.headingId, liveAnchor: st.liveAnchor });
      }
      planStateReadable = true;
    } catch (error) {
      warnings.push(`Plan_Index_State unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const planRefLocators = parsedIndexTabs
    .flatMap((t) => t.terms.flatMap((x) => x.references))
    .filter((r) => r.source === 'Plan')
    .map((r) => r.locator);
  // ⚠ BY ANCHOR FIRST, TEXT ONLY AS A FALLBACK — the same two keys the state
  // reconciliation uses, for the same reason. A RENAMED section's index
  // references still carry the OLD heading wording, so a text-only match calls
  // it unreferenced: OPERATIONAL BACKLOGS is referenced as "…These a" while
  // the tracked locator is now "…This is", and they do not prefix-match.
  // The reference lines are LINKED, so their anchor still identifies the
  // section after any amount of rewording.
  const indexAnchors = new Set(
    indexLinkTabs.flatMap((t) => t.links.map((l) => anchorOf(l)?.headingId).filter((x): x is string => !!x)),
  );
  const isReferenced = (row: { locator: string; headingId: string; liveAnchor: string }): boolean =>
    (row.headingId !== '' && indexAnchors.has(row.headingId)) ||
    (row.liveAnchor !== '' && indexAnchors.has(row.liveAnchor)) ||
    planRefLocators.some((r) => planLocatorMatches(r, row.locator));
  emit(
    'plan-section-unindexed',
    tracked
      .filter((row) => !isReferenced(row))
      .map((row) => ({ ruleId: 'plan-section-unindexed', detail: row.locator })),
    planStateReadable
      ? `${tracked.length} tracked section(s) checked by ANCHOR against ${indexAnchors.size} distinct index link anchor(s), falling back to ${planRefLocators.length} text locator(s)`
      : 'nothing to check — the tracked set was unavailable',
    planStateReadable ? (tracked.length === 0 ? 'Plan_Index_State holds no rows' : null) : 'Plan_Index_State was unavailable — no Sheets client, or the tab could not be read',
  );

  emit(
    'index-covers-plan-headings',
    planHeadingTexts
      .filter((t) => ![...indexPlanRefs].some((r) => t.startsWith(r) || t.toLowerCase().includes(r.toLowerCase())))
      .map((t) => ({ ruleId: 'index-covers-plan-headings', detail: t.slice(0, 110) })),
    `${planHeadingTexts.length} non-blank Plan headings, ${indexPlanRefs.size} distinct Plan locators in the index`,
    noPlanHeadings ?? noIndexContent,
  );

  emit(
    'plan-paragraph-headings',
    paragraphHeadings(planHeadings),
    `${planHeadings.length} Plan headings measured against a 120-character threshold`,
    noPlanHeadings,
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

/**
 * ⚠ A RULE THAT DID NOT RUN REPORTS NOTHING, EVEN IF IT COMPUTED SOMETHING.
 *
 * This is reachable, not defensive. `log-001-tab-inventory` derives its
 * findings by subtracting the tabs it saw from the tabs it expects — so when
 * `listTabs` returns NOTHING, it computes three "missing tab" findings and its
 * precondition fails at the same time. Reporting those would turn a transport
 * failure into three confident claims about the document.
 */
export function buildRuleResult(
  rule: Rule,
  findings: readonly Finding[],
  measured: string,
  notRun: string | null,
): RuleResult {
  return {
    ruleId: rule.id,
    statement: rule.statement,
    earnedBy: rule.earnedBy,
    severity: rule.severity,
    document: rule.document,
    fired: notRun ? false : findings.length > 0,
    findings: notRun ? [] : findings,
    measured,
    notRun,
  };
}
