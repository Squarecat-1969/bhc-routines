/**
 * The checks. Pure — every function takes already-read content and returns
 * findings. No I/O, no credentials, and nothing here can write.
 */

import { KNOWN_LINK_FORMS, anchorOf } from '../../lib/docs.js';
import type { DocHeading, DocLink } from '../../lib/docs.js';

export interface Finding {
  readonly ruleId: string;
  /** The offending line or item, quoted so a reader can judge it in one glance. */
  readonly detail: string;
  readonly line?: number;
}

// --- ToC line classification ------------------------------------------------

/**
 * ⚠ THE ToC'S PROSE IS DELIBERATE AND MUST BE ALLOWED EXPLICITLY.
 *
 * Its opening paragraph, its note about blank page-break headings, its pointer
 * to the keyword index and its closing note about the 2026-09-05 removal are
 * all intentional. A naive "every line must be a heading" check reports all of
 * them, and a report whose first ten lines are wrong is a report nobody reads.
 *
 * An entry line is a CHAPTER line or a bulleted line; everything else is prose.
 */
const CHAPTER_RE = /^CHAPTER\s/;
const BULLET_RE = /^\s+·\s/;

/**
 * ⚠ THE HAND-APPENDED ADDENDUM IS NOT A CLAIM ABOUT LIVE HEADINGS, AND THE
 * DOCUMENT SAYS SO ITSELF.
 *
 * The ToC ends with a block introduced by "UPDATED … Not re-generated from
 * live headings; these were appended by hand". Its lines describe content
 * filed by hand — a "CHAPTER 9 — new entry" label, an INCIDENT 7 entry that is
 * not yet a heading — and checking them against the live heading list reported
 * two findings that are not errors.
 *
 * This is the same reason the opening paragraph is allowed: the ToC's prose is
 * deliberate, and a report whose first entries are wrong is a report nobody
 * reads. The boundary is READ FROM THE DOCUMENT rather than hardcoded to a
 * line number, so it moves when the ToC does — and the number of excluded
 * lines is reported, so the exclusion is visible rather than silent.
 */
const HAND_APPENDED_RE = /not re-generated from live headings/i;

export function handAppendedFrom(tocContent: string): number | null {
  const lines = tocContent.split('\n');
  const i = lines.findIndex((l) => HAND_APPENDED_RE.test(l));
  return i === -1 ? null : i;
}

/** The ToC lines that DO claim to mirror live headings. */
export function generatedTocLines(tocContent: string): { line: string; lineNo: number }[] {
  const lines = tocContent.split('\n');
  const cut = handAppendedFrom(tocContent);
  const upto = cut === null ? lines.length : cut;
  return lines.slice(0, upto).map((line, i) => ({ line, lineNo: i + 1 }));
}

export function isTocEntryLine(line: string): boolean {
  return CHAPTER_RE.test(line) || BULLET_RE.test(line);
}

/** The heading text a ToC entry claims to point at. */
export function tocEntryText(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

/**
 * Normalise for comparison: the ToC reproduces heading text but a heading may
 * carry trailing whitespace or a non-breaking space, and comparing raw strings
 * makes a formatting difference look like a missing heading.
 */
export function normaliseHeadingText(s: string): string {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Placement --------------------------------------------------------------

/**
 * A §NNN RANGE — `§106–§127`, `§001–§035.1` — which is the shape a Dev log
 * inventory takes. NOT a single citation.
 *
 * ⚠ NARROWED 2026-09-06, AND THE NARROWING IS THE POINT.
 *
 * The rule used to fire on ANY §NNN, which made it broader than the incident
 * that earned it. What went wrong on 2026-09-05 was a log TAB INVENTORY living
 * in the Plan's ToC — log content in the wrong document. A citation naming
 * where something is written up in full is not that; it is useful and belongs.
 * The broad form fired on line 95's "inserted before PERMANENT IDENTITY
 * CORRECTIONS · Dev log §123", a true positive against the letter of the rule
 * and a false one against its purpose, which is exactly how a report earns the
 * reader's indifference.
 *
 * ⚠ WHY A RANGE AND NOT "NO TAB INVENTORY". Checked before narrowing: an
 * inventory names tabs by definition, so `toc-no-log-tab-name` would have
 * caught the 2026-09-05 addition on its own, and re-stating the rule as "no
 * inventory" would duplicate it. A RANGE is the one inventory shape the two
 * sibling rules provably cannot see — `log-001 §001–§035.1 · log-002
 * §036–§059` carries no tab name and no document ID, and both siblings pass
 * it. That is what this rule is for.
 *
 * Both en dash and hyphen, because the document uses both.
 */
export const ENTRY_RANGE_RE = /§\d{1,4}(?:\.\d+)?\s*[–—-]\s*§?\d{1,4}(?:\.\d+)?/g;

export function findLogEntryRanges(content: string): Finding[] {
  const out: Finding[] = [];
  content.split('\n').forEach((line, i) => {
    const hits = line.match(ENTRY_RANGE_RE);
    if (hits) {
      out.push({ ruleId: 'toc-no-log-entry-range', detail: `${hits.join(', ')} — ${line.trim()}`, line: i + 1 });
    }
  });
  return out;
}

export function findStrings(content: string, needles: readonly string[], ruleId: string): Finding[] {
  const out: Finding[] = [];
  content.split('\n').forEach((line, i) => {
    for (const n of needles) {
      if (n !== '' && line.includes(n)) out.push({ ruleId, detail: `"${n}" — ${line.trim().slice(0, 160)}`, line: i + 1 });
    }
  });
  return out;
}

/** A Plan heading that is really a log entry. */
export function findLogEntryHeadings(headings: readonly DocHeading[]): Finding[] {
  return headings
    .filter((h) => /^§\d/.test(h.text.trim()))
    .map((h) => ({ ruleId: 'plan-no-log-entries', detail: h.text.slice(0, 120) }));
}

// --- ToC completeness and link targets --------------------------------------

/**
 * ⚠ THE ACCEPTANCE TEST LIVES HERE.
 *
 * A ToC entry whose text matches no surviving heading is a link pointing at an
 * anchor that no longer exists — which is exactly what happened to "PERMANENT
 * IDENTITY CORRECTIONS": the heading was demoted to normal text after the
 * migration linked it, so `h.68mlrx18r7t` resolves to nothing.
 *
 * This catches it WITHOUT reading link markup, which matters because
 * /api/brain/docs carries none in either format — a markdown link check there
 * reports 0 of 83 real links, a zero that reads as a finding and is wrong.
 * The heading's absence is the same defect observed from the other side.
 */
export function tocEntriesWithoutHeading(
  tocContent: string,
  planHeadings: readonly DocHeading[],
): Finding[] {
  const known = new Set(planHeadings.map((h) => normaliseHeadingText(h.text)).filter((t) => t !== ''));
  const out: Finding[] = [];
  for (const { line, lineNo } of generatedTocLines(tocContent)) {
    const i = lineNo - 1;
    if (!isTocEntryLine(line)) continue;
    const text = tocEntryText(line);
    if (text === '') continue;
    const key = normaliseHeadingText(text);
    // A ToC line may abbreviate a long heading, so a prefix match counts. The
    // check is "does a heading with this text still exist", not "is the ToC
    // line byte-identical to it".
    const found = known.has(key) || [...known].some((k) => prefixMatch(k, key));
    if (!found) {
      out.push({ ruleId: 'toc-entry-resolves-to-heading', detail: line.trim(), line: i + 1 });
    }
  }
  return out;
}

/**
 * ⚠ LEVELS 1-2 ONLY, AND THAT IS NOT A SIMPLIFICATION.
 *
 * The ToC lists levels 1 and 2. The Plan tab has 117 headings, of which 92 are
 * at those levels; comparing against all 117 reports 25 phantom omissions.
 * Level 0 exists too and is not a chapter.
 */
/**
 * ⚠ A PREFIX MATCH NEEDS ENOUGH PREFIX TO MEAN ANYTHING.
 *
 * Bare `a.startsWith(b)` treats the empty string as matching everything, which
 * silently made the blank-heading filter in `headingsMissingFromToc` dead
 * code — every blank page-break heading "matched" every ToC line. It would
 * also let a three-character ToC entry claim any heading beginning with those
 * characters. Below the floor, only exact equality counts.
 */
export const PREFIX_MATCH_MIN = 8;

export function prefixMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  if (shorter.length < PREFIX_MATCH_MIN) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export function headingsMissingFromToc(
  tocContent: string,
  planHeadings: readonly DocHeading[],
): Finding[] {
  // The hand-appended block IS allowed to satisfy this direction — a heading
  // listed there is listed, however it got there.
  const tocKeys = tocContent
    .split('\n')
    .filter(isTocEntryLine)
    .map((l) => normaliseHeadingText(tocEntryText(l)))
    .filter((t) => t !== '');
  return planHeadings
    .filter((h) => (h.level === 1 || h.level === 2) && h.text.trim() !== '')
    .filter((h) => {
      const key = normaliseHeadingText(h.text);
      return !tocKeys.some((t) => prefixMatch(t, key));
    })
    .map((h) => ({ ruleId: 'toc-covers-plan-headings', detail: `L${h.level} ${h.text.slice(0, 120)}` }));
}

// --- Recorded figures -------------------------------------------------------

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
};

/**
 * The ToC's own claim about how many blank headings it omits, read out of its
 * prose rather than hardcoded — a hardcoded expectation would go stale the
 * moment the sentence is corrected, and then the check would be the thing
 * that is wrong.
 */
export function statedBlankHeadingCount(tocContent: string): { stated: number; sentence: string } | null {
  const m = /(\w+)\s+blank\s+page-break\s+heading\s+paragraphs?\s+and\s+(\w+)\s+stray\s+blank\s+heading/i.exec(
    tocContent,
  );
  if (!m) return null;
  const a = NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
  const b = NUMBER_WORDS[m[2]!.toLowerCase()] ?? Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { stated: a + b, sentence: m[0] };
}

export function countBlankHeadings(headings: readonly DocHeading[]): number {
  return headings.filter((h) => h.text.trim() === '').length;
}

// --- Hygiene ----------------------------------------------------------------

/**
 * A heading holding an entire paragraph. The threshold is stated rather than
 * implied: it is a judgement about where a title stops being a title, and the
 * report says which threshold produced the number so the figure can be argued
 * with rather than taken on trust.
 */
export const PARAGRAPH_HEADING_CHARS = 120;

export function paragraphHeadings(headings: readonly DocHeading[]): Finding[] {
  return headings
    .filter((h) => h.text.length > PARAGRAPH_HEADING_CHARS)
    .map((h) => ({
      ruleId: 'plan-paragraph-headings',
      detail: `L${h.level} ${h.text.length} chars — ${h.text.slice(0, 90)}…`,
    }));
}

// --- Coverage ---------------------------------------------------------------

export function missingByName(all: readonly string[], covered: ReadonlySet<string>, ruleId: string): Finding[] {
  // ⚠ BY NAME, NEVER AS A COUNT. "12 entries uncovered" tells a reader nothing
  // they can act on.
  return all.filter((x) => !covered.has(x)).map((x) => ({ ruleId, detail: x }));
}

// --- Link targets, by ANCHOR rather than by text -----------------------------

/**
 * ⚠ A DEAD-ANCHOR CHECK IS NOT A TEXT-MATCH CHECK, AND ONE DOES NOT IMPLY THE
 * OTHER.
 *
 * `toc-entry-resolves-to-heading` compares ToC line text to heading text, which
 * is all it could do before `includeLinks` shipped (2026-09-07). It passes
 * `INCIDENT 2` today: same text, live heading, DEAD LINK. The paragraph was
 * retyped during the 2026-09-07 cleanup and Docs minted a fresh ID
 * (h.lagfoh7a5rp3 -> h.cmytyawr14t8) while every character stayed put.
 *
 * ⚠ A HEADING'S IDENTITY DIES WITH THE PARAGRAPH, NOT WITH ITS TEXT. So this
 * resolves the stored anchor against the live heading IDs and never looks at
 * text at all.
 */
export interface LinkCheckInput {
  readonly tabTitle: string;
  readonly links: readonly DocLink[];
  /** documentId -> every heading ID that document currently has. */
  readonly anchorsByDocument: ReadonlyMap<string, ReadonlySet<string>>;
  /** The document the links live in — where a heading-form link must resolve. */
  readonly ownDocumentId: string;
  readonly ruleId: string;
}

export function linksWithDeadAnchors(input: LinkCheckInput): Finding[] {
  const out: Finding[] = [];
  for (const l of input.links) {
    // ⚠ REPORTED, NEVER SKIPPED. Docs stores links in six shapes; a shape this
    // cannot read must surface as a finding, because silently ignoring it
    // reads as "no links here" — the exact wrong-zero this rule exists past.
    if (!KNOWN_LINK_FORMS.includes(l.form)) {
      out.push({ ruleId: input.ruleId, detail: `${input.tabTitle}: UNRECOGNISED LINK FORM "${l.form}" — ${l.text.slice(0, 70)}` });
      continue;
    }
    const a = anchorOf(l);
    if (!a) continue; // a plain external URL names no heading; not this rule's business

    // A heading-form link carries no document ID because it cannot leave its
    // own document. In the INDEX that means a link into itself, which is a
    // different defect (index-no-self-reference) and is reported as such.
    const docId = a.documentId ?? input.ownDocumentId;
    const anchors = input.anchorsByDocument.get(docId);
    if (!anchors) {
      out.push({ ruleId: input.ruleId, detail: `${input.tabTitle}: link to UNKNOWN DOCUMENT ${docId} — ${l.text.slice(0, 60)}` });
      continue;
    }
    if (!anchors.has(a.headingId)) {
      out.push({
        ruleId: input.ruleId,
        detail: `${input.tabTitle}: DEAD ANCHOR ${a.headingId} (${a.form} form) — "${l.text.replace(/\s+/g, ' ').trim().slice(0, 80)}"`,
      });
    }
  }
  return out;
}
