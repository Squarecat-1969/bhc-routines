/**
 * Parsing the index and the sources. Pure — no I/O, no credentials.
 *
 * THE INDEX FORMAT, read from the live document 2026-09-05 rather than from a
 * spec. Each GROUP tab and ADDITIONAL TERMS is:
 *
 *   GROUP: Failure classes          <- tab title line, once
 *   dedup gap  (6 references)       <- a term, TWO spaces before the count
 *   · §008 · 2026-06-02 · Log “…”   <- a reference, one per line
 *   · 5.9 · Plan “…”                <- a Plan reference
 *
 * Counts confirmed against `GROUP: Failure classes`: 8 terms, 25 references,
 * one non-matching line (the title). Reference shapes observed: 18 `Log` with
 * a date, 1 `Log` without one, 6 `Plan`.
 *
 * ⚠ THE HYPERLINKS ARE NOT IN THE PLAIN TEXT. 610 of them were migrated on
 * 2026-08-30 and they live as hyperlink metadata on these lines, invisible to
 * a plain-text read. That is precisely why this routine only ever INSERTS new
 * lines and narrow-range replaces a count — anything that rewrites a line
 * re-renders its anchor. See docs/shared-bridge-contract.md §4.
 */

/**
 * A term header. FOUR shapes exist in the live document, not one, and the
 * differences are load-bearing:
 *
 *   dedup gap  (6 references)                          plain
 *   minting  (26 references, showing 23 of 26)         Rule A — capped at 25
 *   BHC Zoom  (79 references)_                         Rule B — note trailing space
 *   Attio  (824 references)_                           Rule B, followed by:
 *   high-frequency; appears throughout this group's sources, not individually indexed below the cap.
 *
 * ⚠ THE TRAILING SPACE IS REAL AND IT IS NOT COSMETIC. Anchoring the count on
 * `$` silently failed to match 481 of the 640 term headers — every
 * high-frequency term in the document. The parser reported them as absent, and
 * absent terms are indistinguishable from new ones: the whole controlled
 * vocabulary would have been re-proposed as additions. Found by counting
 * shapes against the live tabs rather than by reading the format.
 */
const TERM_RE = /^(.+?) {2}\((\d+) references?(?:, showing (\d+) of (\d+))?\)\s*$/;

/**
 * ADDITIONAL TERMS uses a DIFFERENT header and a richer body:
 *
 *   Accept-handler  (11 occurrences across 1 tabs)
 *   · §031.1 · 2026-07-18 · Log — 11 occurrences
 *       <indented narrative>
 *       "<quoted excerpt>"
 *
 * Parsed so its references reach the WATERMARK — an entry already recorded
 * here is indexed, and missing them would re-judge it every run. Nothing is
 * ever inserted into an existing term on this tab.
 */
const OCCURRENCE_TERM_RE = /^(.+?) {2}\((\d+) occurrences? across (\d+) tabs?\)\s*$/;

/** Rule B's marker line, which follows a high-frequency term header. */
const HIGH_FREQUENCY_RE = /^\s*high-frequency; appears throughout/;

/** `· §008 · 2026-06-02 · Log “…”` / `· §088 · Log “…”` / `· 5.9 · Plan “…”` */
const REF_RE = /^· (.+?) · (?:(\d{4}-\d{2}-\d{2}) · )?(Log|Plan) /;

export interface IndexReference {
  /** `§008`, or a Plan section like `5.9` / `Ch 11`. */
  readonly locator: string;
  readonly date: string | null;
  readonly source: 'Log' | 'Plan';
  /** The line exactly as it appears. Never rewritten — only compared. */
  readonly line: string;
}

export interface IndexTerm {
  readonly term: string;
  readonly declaredCount: number;
  /**
   * ⚠ TRUE MEANS NO REFERENCE LINE MAY BE ADDED.
   *
   * Rule A caps a term at 25 shown references; Rule B replaces them with a
   * one-line note. Appending to either breaks the document's own stated
   * convention and makes the header's arithmetic a lie. The count is still
   * updated — the term really did gain a reference — but the reference itself
   * is not written.
   */
  readonly capped: boolean;
  readonly shownCount: number | null;
  readonly highFrequency: boolean;
  readonly references: readonly IndexReference[];
  /** The header line verbatim, so a count update can anchor on it. */
  readonly headerLine: string;
  /** 0-based line number within the tab. */
  readonly headerLineNo: number;
  /** Line number of the last reference, or the header when there are none. */
  readonly lastLineNo: number;
}

export interface IndexTab {
  readonly tabId: string;
  readonly title: string;
  readonly terms: readonly IndexTerm[];
  /** Lines that are neither a term nor a reference — the title, blanks, prose. */
  readonly unparsedLines: readonly { lineNo: number; text: string }[];
}

export function parseIndexTab(tabId: string, title: string, content: string): IndexTab {
  const lines = content.split('\n');
  const terms: IndexTerm[] = [];
  const unparsedLines: { lineNo: number; text: string }[] = [];

  let current: {
    term: string;
    declaredCount: number;
    capped: boolean;
    shownCount: number | null;
    highFrequency: boolean;
    references: IndexReference[];
    headerLine: string;
    headerLineNo: number;
    lastLineNo: number;
  } | null = null;

  const flush = (): void => {
    if (current) terms.push({ ...current, references: current.references });
    current = null;
  };

  lines.forEach((line, lineNo) => {
    const termMatch = TERM_RE.exec(line) ?? OCCURRENCE_TERM_RE.exec(line);
    if (termMatch) {
      flush();
      // The occurrence form's group 3 is a TAB COUNT, not a shown-count, so
      // it must not be read as a Rule A cap.
      const isOccurrenceForm = OCCURRENCE_TERM_RE.test(line);
      const shown = !isOccurrenceForm && termMatch[3] !== undefined ? Number(termMatch[3]) : null;
      current = {
        term: termMatch[1]!,
        declaredCount: Number(termMatch[2]),
        capped: shown !== null,
        shownCount: shown,
        highFrequency: false,
        references: [],
        headerLine: line,
        headerLineNo: lineNo,
        lastLineNo: lineNo,
      };
      return;
    }

    if (current && HIGH_FREQUENCY_RE.test(line)) {
      current.highFrequency = true;
      current.capped = true;
      current.lastLineNo = lineNo;
      return;
    }

    const refMatch = REF_RE.exec(line);
    if (refMatch && current) {
      current.references.push({
        locator: refMatch[1]!,
        date: refMatch[2] ?? null,
        source: refMatch[3] as 'Log' | 'Plan',
        line,
      });
      current.lastLineNo = lineNo;
      return;
    }

    if (line.trim() !== '') unparsedLines.push({ lineNo, text: line });
  });
  flush();

  return { tabId, title, terms, unparsedLines };
}

/**
 * A source entry: `§106 — Calendar evidence: … · 2026-09-01`.
 *
 * ⚠ THE SECTION MARKER MUST START THE LINE. The log cites its own sections
 * constantly mid-sentence ("the same failure mode as §092"), and a looser
 * pattern would turn every cross-reference into a phantom entry.
 */
const ENTRY_RE = /^(§\d+(?:\.\d+)?) — (.+)$/;
const ENTRY_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

export interface SourceEntry {
  readonly locator: string;
  readonly title: string;
  readonly date: string | null;
  /** 0-based line number of the heading within the tab. */
  readonly lineNo: number;
  /** The entry's body, for the LLM to read. Bounded by the next heading. */
  readonly body: string;
  /**
   * The Google Docs anchor for this entry's heading, as the ROUTE built it.
   * Null when the source was read without headings, or when Google gave the
   * heading no anchor (`linkable: false`) — in which case the reference is
   * written plain rather than linked to the wrong place.
   */
  readonly headingUrl: string | null;
}

/** headingId -> url, keyed by the heading TEXT the tab actually carries. */
export type HeadingUrls = ReadonlyMap<string, string>;

/**
 * Index the route's headings by locator, so an entry can find its own anchor.
 *
 * ⚠ KEYED ON THE LOCATOR PARSED OUT OF THE HEADING TEXT, not on position.
 * The headings array and the parsed entries are two independent walks of the
 * same tab; pairing them by array index would silently mis-link every entry
 * after the first non-entry heading (the tab title is one).
 */
export function headingUrlsByLocator(
  headings: readonly { text: string; url: string; linkable: boolean }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of headings) {
    if (!h.linkable) continue;
    const m = ENTRY_RE.exec(h.text);
    if (m) out.set(m[1]!, h.url);
  }
  return out;
}

export function parseSourceTab(content: string, headingUrls?: HeadingUrls): SourceEntry[] {
  const lines = content.split('\n');
  const heads: { locator: string; title: string; lineNo: number }[] = [];

  lines.forEach((line, lineNo) => {
    const m = ENTRY_RE.exec(line);
    if (m) heads.push({ locator: m[1]!, title: m[2]!, lineNo });
  });

  return heads.map((h, i) => {
    const endLine = i + 1 < heads.length ? heads[i + 1]!.lineNo : lines.length;
    const body = lines.slice(h.lineNo, endLine).join('\n');
    const dateMatch = ENTRY_DATE_RE.exec(h.title) ?? ENTRY_DATE_RE.exec(body.slice(0, 400));
    return {
      locator: h.locator,
      title: h.title,
      date: dateMatch ? dateMatch[1]! : null,
      lineNo: h.lineNo,
      body,
      headingUrl: headingUrls?.get(h.locator) ?? null,
    };
  });
}

/**
 * A short excerpt for a reference line, taken from the entry's own text.
 *
 * The existing index quotes a run of source words inside curly quotes. The
 * excerpt is taken VERBATIM from the body so the index keeps quoting its
 * source rather than paraphrasing it, and newlines are flattened because a
 * reference is one line.
 */
export function excerptFor(entry: SourceEntry, maxChars = 150): string {
  const afterHeading = entry.body.split('\n').slice(1).join(' ');
  const flattened = (afterHeading || entry.title).replace(/\s+/g, ' ').trim();
  if (flattened.length <= maxChars) return flattened;
  const cut = flattened.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
}
