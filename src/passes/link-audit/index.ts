/**
 * THE LINK AUDIT — a dry run, and a deliverable in its own right.
 *
 * Index reference lines that carry no hyperlink. They are correct, readable and
 * carry their locator; a reader finds the entry by searching the text. The link
 * saves a click. This produces the work list for closing that gap.
 *
 * ⚠ IT WRITES NOTHING, AND THERE IS NO WRITE HALF TO ENABLE. `linkRange` was
 * REFUSED on 2026-09-08 — see docs/link-range-spec.md §7 in bhc-aida. Measured
 * on a scratch document, a `fields:"link"` update also overwrites
 * `foregroundColor` and `underline`: explicit red became link blue and an
 * explicit `underline:false` became true, from a request whose field mask said
 * `link` only. Two of those three changes are invisible to the proposed
 * verification, which is precisely the property the absent styling action
 * protects. So the emitted URLs are for a human to click, not for a routine to
 * write.
 *
 * ⚠ THE COUNT IS RE-DERIVED EVERY RUN AND IS NEVER A CONSTANT. It has been
 * reported as 90, then 101, then 91 — each measured at a different moment, each
 * correct then. Nothing here hardcodes a total, and the report prints the
 * number it actually found.
 */

import {
  INDEX_DOC_ID,
  SOURCES_INDEXED_TAB,
  SOURCE_TABS,
} from '../index-maintenance/constants.js';
import { headingUrlsByLocator, parseIndexTab, type IndexReference } from '../index-maintenance/parse.js';
import type { DocsClient } from '../../lib/docs.js';
import { silentLogger, type Logger } from '../../lib/logger.js';

/** How many preceding lines an anchor may grow to before we give up. */
export const MAX_ANCHOR_LINES = 6;

/**
 * The bullet every reference line starts with. The linked run in a MIGRATED
 * line begins immediately after it — measured 2026-09-08 across all 1,332
 * linked references: the run's line-prefix is `· ` in every single case.
 */
const BULLET = '· ';

export type AuditStatus = 'resolved' | 'ambiguous' | 'no-url' | 'find-failed';

export interface AuditRow {
  readonly tabId: string;
  readonly tabTitle: string;
  readonly term: string;
  readonly locator: string;
  readonly date: string | null;
  readonly source: 'Log' | 'Plan';
  readonly lineNo: number;
  /** The whole reference line, verbatim. */
  readonly line: string;
  /** The substring that should carry the link. */
  readonly target: string;
  /** Text immediately preceding `target`, which makes it unique. */
  readonly anchor: string | null;
  /** How many preceding lines the anchor needed. */
  readonly anchorLines: number | null;
  readonly startIndex: number | null;
  readonly endIndex: number | null;
  readonly url: string | null;
  readonly status: AuditStatus;
  /** Why, whenever status is not `resolved`. Never blank on a failure. */
  readonly note: string;
}

export interface LinkAuditResult {
  readonly rows: readonly AuditRow[];
  readonly tabsRead: number;
  readonly referenceLines: number;
  readonly linkedLines: number;
  readonly warnings: readonly string[];
}

/**
 * The portion of a reference line that should carry the link.
 *
 * ⚠ DERIVED FROM THE SAME REGEX THE PARSER USES, and confirmed against the
 * corpus rather than assumed: every one of the 1,332 already-linked runs is
 * `<locator> · <date> · Log|Plan`, sitting immediately after `· ` and stopping
 * before the space that precedes the quotation.
 */
export function targetTextFor(line: string): string | null {
  const m = /^· (.+?) · (?:(\d{4}-\d{2}-\d{2}) · )?(Log|Plan) /.exec(line);
  if (!m) return null;
  return line.slice(BULLET.length, m[0].length - 1); // -1 drops the trailing space
}

/**
 * Which plain-text offsets in this tab are covered by a link.
 *
 * A line counts as LINKED if any character of it is inside a link. That is the
 * right test for "leave it alone": a partially linked line is already claimed,
 * and re-linking it is the case guard 3 exists to refuse.
 */
export function linkedOffsets(content: string, links: readonly { plainTextStartIndex: number; plainTextEndIndex: number }[]): boolean[] {
  const cov = new Array<boolean>(content.length).fill(false);
  for (const l of links) {
    const end = Math.min(l.plainTextEndIndex, content.length);
    for (let i = Math.max(0, l.plainTextStartIndex); i < end; i++) cov[i] = true;
  }
  return cov;
}

/** Start offset of each line, so coverage can be tested per line. */
function lineOffsets(lines: readonly string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const l of lines) { out.push(at); at += l.length + 1; }
  return out;
}

/**
 * The shortest run of PRECEDING lines that makes this reference unique.
 *
 * ⚠ THIS IS THE ONLY THING STANDING BETWEEN A CORRECT LINK AND A PERMANENT
 * MISLINK. 59 of the 91 unlinked lines have a byte-identical twin, and
 * `expectedText` cannot tell them apart precisely because they are identical.
 * Only preceding context can.
 *
 * The returned string ends with the bullet, so it is the text IMMEDIATELY
 * before `target` — which is what the route's `precededBy` requires.
 *
 * Returns null when no span up to MAX_ANCHOR_LINES disambiguates. A null is a
 * NAMED REPORT LINE, never a guess and never a silent omission.
 */
export function anchorFor(
  content: string,
  lines: readonly string[],
  lineNo: number,
  target: string,
): { anchor: string; lines: number } | null {
  for (let span = 1; span <= MAX_ANCHOR_LINES; span++) {
    if (lineNo - span < 0) break;
    const anchor = `${lines.slice(lineNo - span, lineNo).join('\n')}\n${BULLET}`;
    // Count how many places in the tab carry this anchor followed by this
    // target. One is unique; the route will independently reach the same
    // verdict, and a disagreement between the two is worth knowing about.
    let hits = 0;
    let from = 0;
    const needle = anchor + target;
    for (;;) {
      const at = content.indexOf(needle, from);
      if (at === -1) break;
      hits += 1;
      if (hits > 1) break;
      from = at + 1;
    }
    if (hits === 1) return { anchor, lines: span };
  }
  return null;
}

/** The GROUP tabs, i.e. everything the index parses as terms. */
function groupTabIds(tabIds: readonly string[]): string[] {
  return tabIds.filter((t) => t !== SOURCES_INDEXED_TAB);
}

export interface LinkAuditOptions {
  readonly docs: DocsClient;
  readonly logger?: Logger;
  /** Override the tabs audited. Defaults to every index tab except SOURCES INDEXED. */
  readonly tabIds?: readonly string[];
  /** Skip the `find` round-trip. Ranges come back null; everything else stands. */
  readonly skipFind?: boolean;
}

export async function runLinkAudit(opts: LinkAuditOptions): Promise<LinkAuditResult> {
  const logger = opts.logger ?? silentLogger;
  const warnings: string[] = [];

  // ── The URL map. NEVER a reconstructed string ────────────────────────────
  //
  // ⚠ EVERY URL COMES FROM THE ROUTE'S OWN headings[].url. Building the same
  // string twice is how a wrong anchor links to the top of a document while
  // every verification still passes — the trap already recorded for
  // insertLink. headingUrlsByLocator keys on the locator parsed out of the
  // heading TEXT, never on array position.
  const urlByLocator = new Map<string, string>();
  for (const src of SOURCE_TABS) {
    const read = await opts.docs.read(src.documentId, src.tabId, true, false);
    const map = headingUrlsByLocator(read.headings ?? []);
    for (const [loc, url] of map) {
      const prior = urlByLocator.get(loc);
      if (prior && prior !== url) {
        warnings.push(`locator ${loc} resolves to two different headings — ${src.label} disagrees with an earlier source; leaving the first`);
        continue;
      }
      urlByLocator.set(loc, url);
    }
    logger.info(`  ${src.label.padEnd(30)} ${String(map.size).padStart(4)} linkable headings`);
  }
  logger.info(`  ${urlByLocator.size} locator(s) have a heading URL`);

  // ── The index tabs ───────────────────────────────────────────────────────
  const tabIds = opts.tabIds
    ? [...opts.tabIds]
    : groupTabIds((await opts.docs.listTabs(INDEX_DOC_ID)).map((t) => t.tabId));

  const rows: AuditRow[] = [];
  let referenceLines = 0;
  let linkedLines = 0;

  for (const tabId of tabIds) {
    const read = await opts.docs.read(INDEX_DOC_ID, tabId, false, true);
    const content = read.content;
    const lines = content.split('\n');
    const offs = lineOffsets(lines);
    const cov = linkedOffsets(content, read.links ?? []);
    const tab = parseIndexTab(tabId, read.tabTitle, content);

    let plainHere = 0;
    for (const term of tab.terms) {
      for (const ref of term.references) {
        referenceLines += 1;
        const start = offs[ref.lineNo] ?? 0;
        const isLinked = cov.slice(start, start + ref.line.length).some(Boolean);
        if (isLinked) { linkedLines += 1; continue; }
        plainHere += 1;
        rows.push(buildRow(content, lines, tab.title, tabId, term.term, ref, urlByLocator));
      }
    }
    logger.info(`  ${tabId.padEnd(18)} ${String(read.linkCount ?? 0).padStart(4)} links · ${String(plainHere).padStart(3)} unlinked reference line(s) · ${read.tabTitle}`);
  }

  // ── Ranges, from the route, with no caller arithmetic ────────────────────
  if (!opts.skipFind) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.status !== 'resolved' || r.anchor === null) continue;
      try {
        const f = await opts.docs.find(INDEX_DOC_ID, r.tabId, r.target, r.anchor);
        rows[i] = { ...r, startIndex: f.startIndex, endIndex: f.endIndex };
      } catch (e) {
        rows[i] = {
          ...r,
          status: 'find-failed',
          note: `the route could not resolve a single range for this line: ${String(e)}`,
        };
      }
    }
  }

  return { rows, tabsRead: tabIds.length, referenceLines, linkedLines, warnings };
}

function buildRow(
  content: string,
  lines: readonly string[],
  tabTitle: string,
  tabId: string,
  term: string,
  ref: IndexReference,
  urlByLocator: ReadonlyMap<string, string>,
): AuditRow {
  const base = {
    tabId, tabTitle, term,
    locator: ref.locator, date: ref.date, source: ref.source,
    lineNo: ref.lineNo, line: ref.line,
  };

  const target = targetTextFor(ref.line);
  if (target === null) {
    return { ...base, target: '', anchor: null, anchorLines: null, startIndex: null, endIndex: null, url: null,
      status: 'ambiguous', note: 'the line does not match the reference-line shape, so no link target can be identified' };
  }

  const a = anchorFor(content, lines, ref.lineNo, target);
  const url = urlByLocator.get(ref.locator) ?? null;

  if (a === null) {
    return { ...base, target, anchor: null, anchorLines: null, startIndex: null, endIndex: null, url,
      status: 'ambiguous',
      note: `no run of up to ${MAX_ANCHOR_LINES} preceding lines makes this line unique — it must be disambiguated by hand, never guessed` };
  }
  if (url === null) {
    // ⚠ NAME THE NEAR MISSES RATHER THAN GUESSING AT A CAUSE. Measured
    // 2026-09-08, all four no-url rows are §091 — a locator the index cites
    // four times and the Log has no heading for; only §091.1, §091.2 and
    // §091.3 exist. "May be unindexed" would have sent someone looking for a
    // missing entry instead of a mis-cited one.
    const near = [...urlByLocator.keys()]
      .filter((k) => k !== ref.locator && k.startsWith(`${ref.locator}.`))
      .sort();
    const detail = near.length > 0
      ? `the source has no heading for ${ref.locator} itself, only ${near.join(', ')} — the reference cites a locator that does not exist as a heading`
      : `no linkable heading was found for ${ref.locator} in any source tab, and no sub-entry of it either — the entry may be genuinely unindexed`;
    return { ...base, target, anchor: a.anchor, anchorLines: a.lines, startIndex: null, endIndex: null, url: null,
      status: 'no-url', note: detail };
  }
  return { ...base, target, anchor: a.anchor, anchorLines: a.lines, startIndex: null, endIndex: null, url,
    status: 'resolved', note: '' };
}
