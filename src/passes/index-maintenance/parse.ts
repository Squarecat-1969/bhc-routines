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
  /**
   * 0-based line number within the tab.
   *
   * The parser has always known this and used to discard it. The link audit
   * needs it to build a disambiguating anchor out of PRECEDING lines, and
   * re-deriving it by searching for `line` would be exactly the wrong move —
   * 59 of the 91 unlinked reference lines have a byte-identical twin, so a
   * search would find the wrong one.
   */
  readonly lineNo: number;
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
        lineNo,
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
  /** Which document this came from — decides the reference line's `Log`/`Plan` word. */
  readonly sourceKind: 'Log' | 'Plan';
  /**
   * ⚠ TRUE WHEN THE PROMPT DID NOT SEE THE WHOLE UNIT. Carried on the entry so
   * a partially-read section is REPORTED rather than inferred: a unit indexed
   * from its first N characters is byte-indistinguishable in the index from one
   * indexed in full.
   */
  readonly truncatedTo?: number;
  readonly locator: string;
  readonly title: string;
  readonly date: string | null;
  /** Plan units only: the unit's TRUE length, before any prompt truncation. */
  readonly fullLength?: number;
  /** Plan units only: the unit's whole text. Hashed; never sent to the model. */
  readonly fullBody?: string;
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
      sourceKind: 'Log',
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


// --- The Developer's Plan --------------------------------------------------

/**
 * THE PLAN HAS NO §NNN STRUCTURE, so `parseSourceTab` returns zero for it and
 * always has. Its 291 index references were written by hand.
 *
 * ⚠ THE UNIT IS THE LEVEL-2/3 HEADING AND ITS TEXT TO THE NEXT HEADING OF ANY
 * LEVEL — and that is not a design choice, it is the granularity the index
 * already uses. Measured 2026-09-08, the 291 references resolve 202 to L2
 * headings, 55 to L3 and 34 to nothing. Choosing a different unit would produce
 * a second scheme sitting inside one list.
 *
 * Level 1 headings are NOT units: a chapter is its sub-sections, and indexing
 * it separately double-counts. Blank headings (15 of them, page-break
 * artifacts) are skipped — the ToC omits them deliberately and says so.
 */
const PLAN_UNIT_LEVELS = new Set([2, 3]);

/**
 * The locator, reproducing the convention the 69 hand-written ones already use.
 *
 * Measured: 29 are a leading numeric token (`5.1`, `8.10`, `3a`, `3b`), the
 * rest are heading text truncated by eye to between 48 and 64 characters.
 * The numeric form is reproduced exactly; the text form is truncated
 * consistently at a word boundary, which is the one place this cannot match a
 * hand-written locator character for character.
 *
 * ⚠ THAT MISMATCH IS WHY DEDUPLICATION USES PREFIX MATCHING, NOT EQUALITY —
 * see `planLocatorMatches`. Generating "…These are t" where a human wrote
 * "…These a" would otherwise add a second reference for a section already
 * indexed, which is the one thing the additive design must not do.
 */
export const PLAN_LOCATOR_MAX = 64;
const NUMERIC_LOCATOR_RE = /^(\d+(?:\.\d+)?[a-z]?)\s+\S/;

export function planLocator(headingText: string): string {
  const flat = headingText.replace(/\s+/g, ' ').trim();
  const numeric = NUMERIC_LOCATOR_RE.exec(flat);
  if (numeric) return numeric[1]!;
  if (flat.length <= PLAN_LOCATOR_MAX) return flat;
  const cut = flat.slice(0, PLAN_LOCATOR_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > PLAN_LOCATOR_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Does a generated locator refer to the same section as an existing one?
 *
 * ⚠ PREFIX MATCHING, DELIBERATELY, AND ONLY ABOVE A LENGTH FLOOR. A text
 * locator may differ only in where it was truncated — 48 characters by one
 * hand, 64 by another — so either being a prefix of the other is the same
 * section.
 *
 * ⚠ THE FLOOR IS THE ONLY GUARD, AND IT IS THE ONE THAT KEEPS `5.1` AWAY FROM
 * `5.10`. An earlier version carried a second, explicit "a numeric locator is
 * exact or nothing" branch in front of it. Mutation testing killed that
 * branch's justification rather than the branch: every numeric locator this
 * file produces is a bare token of at most six characters, so the floor
 * already decides every numeric comparison and NO INPUT COULD DISTINGUISH THE
 * TWO RULES. A guard no test can kill is a guard nobody is maintaining, so
 * there is now one rule and the floor's numeric consequence is stated here
 * instead of duplicated below.
 *
 * Lowering this floor below the length of a numeric token re-opens exactly
 * that conflation — the test named for `5.1` / `5.10` is what holds it shut.
 */
export const PLAN_LOCATOR_PREFIX_MIN = 12;

export function planLocatorMatches(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, ' ').trim().toLowerCase();
  const y = b.replace(/\s+/g, ' ').trim().toLowerCase();
  if (x === y) return true;
  const shorter = x.length < y.length ? x : y;
  if (shorter.length < PLAN_LOCATOR_PREFIX_MIN) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export interface PlanHeadingLike {
  readonly headingId: string;
  readonly level: number;
  readonly text: string;
  readonly plainTextStartIndex: number;
  readonly linkable: boolean;
  readonly url: string;
}

/**
 * Split the Plan tab into indexable units.
 *
 * ⚠ THE 17 PARAGRAPH-HEADINGS ARE NOT A SPECIAL CASE HERE, AND THAT IS WHY
 * THIS WORKS. For `INCIDENT 2 — …` (1,285 characters of heading) the heading
 * text IS the body, and since the body is taken as "from this heading to the
 * next", it already contains the heading. Nothing needs to detect them.
 */
export function parsePlanSections(
  content: string,
  headings: readonly PlanHeadingLike[],
  opts: { readonly maxChars: number },
): SourceEntry[] {
  const ordered = [...headings].sort((a, b) => a.plainTextStartIndex - b.plainTextStartIndex);
  const out: SourceEntry[] = [];

  ordered.forEach((h, i) => {
    if (!PLAN_UNIT_LEVELS.has(h.level)) return;
    if (h.text.trim() === '') return; // blank page-break heading
    const end = i + 1 < ordered.length ? ordered[i + 1]!.plainTextStartIndex : content.length;
    const full = content.slice(h.plainTextStartIndex, end);
    const truncated = full.length > opts.maxChars;
    out.push({
      sourceKind: 'Plan',
      locator: planLocator(h.text),
      title: h.text.replace(/\s+/g, ' ').trim().slice(0, 200),
      date: null,
      lineNo: content.slice(0, h.plainTextStartIndex).split('\n').length,
      body: truncated ? full.slice(0, opts.maxChars) : full,
      headingUrl: h.linkable ? h.url : null,
      ...(truncated ? { truncatedTo: opts.maxChars } : {}),
      // ⚠ HASHED FROM THE WHOLE UNIT, NEVER THE TRUNCATED PROMPT SLICE. A hash
      // of what the model saw would miss every change in the part it did not.
      fullLength: full.length,
      fullBody: full,
    });
  });

  return out;
}
