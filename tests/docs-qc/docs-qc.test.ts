/**
 * Documents QC — pure checks, no credentials.
 *
 * ⚠ FIXTURES ARE THE REAL LINES, from the live ToC and Plan tab on 2026-09-06.
 * The acceptance test is a fixture here: "PERMANENT IDENTITY CORRECTIONS" sits
 * in the ToC and is NOT a heading in the Plan tab, because it was demoted to
 * normal text after the 2026-08-30 migration linked it.
 *
 * ⚠ EVERY RULE IS TESTED IN BOTH DIRECTIONS where it could be too tight. A
 * one-directional test proves nothing about over-tightening — the 84-link
 * corpus passed an allowlist-only rule happily because every member of it was
 * `docs.google.com`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { DocHeading } from '../../src/lib/docs.js';
import {
  countBlankHeadings,
  findLogEntryHeadings,
  findLogEntryRefs,
  findStrings,
  generatedTocLines,
  handAppendedFrom,
  headingsMissingFromToc,
  isTocEntryLine,
  missingByName,
  paragraphHeadings,
  prefixMatch,
  statedBlankHeadingCount,
  tocEntriesWithoutHeading,
} from '../../src/passes/docs-qc/checks.js';
import { RULES, ruleById } from '../../src/passes/docs-qc/manifest.js';

const heading = (text: string, level = 2, headingId = 'h.x'): DocHeading => ({
  headingId, level, text, startIndex: 1, endIndex: 2, plainTextStartIndex: 0, linkable: true, url: 'https://e',
});

/** Verbatim from the live ToC, 2026-09-06. */
const TOC = [
  "BHC Aida ROS — Developer's Plan — Table of Contents",
  'This document is the single authoritative description of the system’s shape. This Table of Contents is generated from that tab’s live headings. Ten blank page-break heading paragraphs and one stray blank heading carry no content and are omitted below rather than listed as empty entries.',
  'This Table of Contents covers Repos · Stores · Routines and nothing else — prose, not an entry.',
  'CHAPTER 1 — System Overview & Stack',
  '    · Repos',
  'CHAPTER 9 — Identity & Data Integrity System (incident ledger)',
  '    · INCIDENT 1 — June 12 corruption',
  '    · PERMANENT IDENTITY CORRECTIONS — not incidents, but recorded here so they are never re-litigated',
  'UPDATED 2026-09-05 — entries added since this Table of Contents was last generated. Not re-generated from live headings; these were appended by hand.',
  'CHAPTER 9 — new entry',
  '    · INCIDENT 7 — The mint contract was violated on three of five clauses',
  '        (inserted before PERMANENT IDENTITY CORRECTIONS · Dev log §123)',
].join('\n');

const PLAN_HEADINGS: DocHeading[] = [
  heading('CHAPTER 1 — System Overview & Stack', 1),
  heading('Repos', 2),
  heading('CHAPTER 9 — Identity & Data Integrity System (incident ledger)', 1),
  heading('INCIDENT 1 — June 12 corruption', 2),
  heading('INCIDENT 7 — Part D wrote into Tasks_Open, a FILTER view, for five weeks', 2),
  // ⚠ "PERMANENT IDENTITY CORRECTIONS" is deliberately ABSENT — demoted to
  // normal text, which is the whole acceptance test.
  heading('', 2), heading('', 2), heading('', 1), // blank page-break headings
  heading('§999 — a log entry that must not be here', 2),
  // ⚠ Mentions a log entry mid-text and is NOT one. The rule is about where an
  // entry LIVES, not about the characters appearing anywhere.
  heading('INCIDENT 8 — the mint audit, recorded in Dev log §123', 2),
];

describe('the manifest', () => {
  it('gives every rule an earning incident — no speculative rules', () => {
    for (const r of RULES) {
      expect(r.earnedBy.length, `${r.id} has no incident`).toBeGreaterThan(40);
      expect(r.statement.length).toBeGreaterThan(20);
    }
  });

  it('names the valid rules when asked for an unknown one', () => {
    expect(() => ruleById('nope')).toThrow(/Valid:/);
  });

  it('agrees with docs/qc-manifest.md — the human copy is not allowed to drift', () => {
    // A rule a person cannot read is a rule that cannot prevent anything.
    const md = readFileSync('docs/qc-manifest.md', 'utf8');
    for (const r of RULES) expect(md, `${r.id} missing from the manifest doc`).toContain(r.id);
  });
});

describe('ToC line classification', () => {
  it('treats CHAPTER and bulleted lines as entries', () => {
    expect(isTocEntryLine('CHAPTER 1 — System Overview & Stack')).toBe(true);
    expect(isTocEntryLine('    · Repos')).toBe(true);
    expect(isTocEntryLine('        · (KEPT FOR REFERENCE)')).toBe(true);
  });

  // ⚠ THE OTHER DIRECTION. The prose is deliberate and must NOT be an entry.
  it('does NOT treat the deliberate prose preamble as an entry', () => {
    expect(isTocEntryLine(TOC.split('\n')[1]!)).toBe(false);
    // ⚠ Prose uses '·' as a separator. A bare /·/ makes every such line an
    // entry, and then the ToC's own sentences are reported as broken links.
    expect(isTocEntryLine(TOC.split('\n')[2]!)).toBe(false);
    expect(isTocEntryLine('Repos · Stores · Routines')).toBe(false);
    expect(isTocEntryLine('FOR DEV LOG COVERAGE, SEE THE KEYWORD INDEX.')).toBe(false);
    expect(isTocEntryLine('')).toBe(false);
  });
});

describe('the hand-appended addendum', () => {
  it('finds the boundary from the document’s own marker, not a line number', () => {
    expect(handAppendedFrom(TOC)).toBe(8);
    expect(generatedTocLines(TOC)).toHaveLength(8);
  });

  it('returns null when no such block exists, and then checks everything', () => {
    const plain = 'CHAPTER 1 — A\n    · B';
    expect(handAppendedFrom(plain)).toBeNull();
    expect(generatedTocLines(plain)).toHaveLength(2);
  });
});

describe('toc-entry-resolves-to-heading — THE ACCEPTANCE TEST', () => {
  it('⚠ FINDS the ToC entry whose heading no longer exists', () => {
    const found = tocEntriesWithoutHeading(TOC, PLAN_HEADINGS);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('PERMANENT IDENTITY CORRECTIONS');
    expect(found[0]!.line).toBe(8);
  });

  // ⚠ THE OTHER DIRECTION — over-tightening is what makes a report ignorable.
  it('does NOT fire on an entry whose heading is present', () => {
    const found = tocEntriesWithoutHeading(TOC, PLAN_HEADINGS);
    expect(found.map((f) => f.detail).join(' ')).not.toContain('INCIDENT 1');
    expect(found.map((f) => f.detail).join(' ')).not.toContain('CHAPTER 1');
  });

  it('does NOT fire inside the hand-appended block', () => {
    // "CHAPTER 9 — new entry" and that INCIDENT 7 line match no heading, and
    // the ToC says that block is not generated from live headings.
    const found = tocEntriesWithoutHeading(TOC, PLAN_HEADINGS);
    expect(found.map((f) => f.detail).join(' ')).not.toContain('new entry');
    expect(found.map((f) => f.detail).join(' ')).not.toContain('mint contract');
  });

  it('accepts a ToC line that abbreviates a longer heading', () => {
    const hs = [heading('INCIDENT 4 — Part D’s month of silent zero-writes (found 2026-08-15)', 2)];
    expect(tocEntriesWithoutHeading('    · INCIDENT 4 — Part D’s month of silent zero-writes', hs)).toEqual([]);
  });
});

describe('toc-covers-plan-headings', () => {
  it('reports a level-1/2 heading missing from the ToC', () => {
    const missing = headingsMissingFromToc(TOC, PLAN_HEADINGS);
    expect(missing.map((m) => m.detail).join(' ')).toContain('§999');
  });

  // ⚠ LEVELS 1-2 ONLY. Comparing against all 117 reports 25 phantom omissions.
  it('IGNORES level-3 headings, which the ToC does not list', () => {
    const hs = [...PLAN_HEADINGS, heading('3a — The NextAuth credential bypass', 3)];
    expect(headingsMissingFromToc(TOC, hs).map((m) => m.detail).join(' ')).not.toContain('3a —');
  });

  it('IGNORES blank page-break headings', () => {
    // They carry real anchors but no text; the ToC omits them deliberately and
    // says so. Reporting 15 empty omissions every week is how a check becomes
    // noise.
    const missing = headingsMissingFromToc(TOC, PLAN_HEADINGS);
    expect(missing.every((m) => m.detail.replace(/^L\d\s*/, '').trim() !== '')).toBe(true);
    expect(missing.map((m) => m.detail)).not.toContain('L2 ');
    expect(missing.map((m) => m.detail)).not.toContain('L1 ');
  });
});

describe('recorded figures', () => {
  it('reads the ToC’s own stated count out of its prose, in words', () => {
    // Read from the document, not hardcoded — a hardcoded expectation goes
    // stale the moment the sentence is corrected, and then the CHECK is wrong.
    expect(statedBlankHeadingCount(TOC)).toMatchObject({ stated: 11 });
  });

  it('counts the blank headings that actually exist', () => {
    expect(countBlankHeadings(PLAN_HEADINGS)).toBe(3);
  });

  it('returns null when the ToC states no such figure, rather than guessing', () => {
    expect(statedBlankHeadingCount('CHAPTER 1 — A')).toBeNull();
  });
});

describe('placement rules', () => {
  it('finds a §NNN reference in the ToC', () => {
    const f = findLogEntryRefs(TOC);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain('§123');
  });

  it('does NOT fire on a chapter number that is not a log reference', () => {
    expect(findLogEntryRefs('CHAPTER 5.9 — HF Segment Sync\n    · 7.5 the Attio bridging chain')).toEqual([]);
  });

  it('finds a log document ID, and ignores an unrelated one', () => {
    const ids = ['1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA'];
    expect(findStrings('see doc 1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA', ids, 'r')).toHaveLength(1);
    expect(findStrings('see doc 1Hx1gXee4cltomMJbb2Z54etg4P1EO8VtRXURiYULDOI', ids, 'r')).toEqual([]);
  });

  it('finds a §NNN heading in the Plan, and ignores a real chapter heading', () => {
    const found = findLogEntryHeadings(PLAN_HEADINGS);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('§999');
    expect(findLogEntryHeadings([heading('CHAPTER 9 — Identity', 1)])).toEqual([]);
    // ⚠ THE OTHER DIRECTION: a heading that merely CITES a log entry is not one.
    expect(found.map((f) => f.detail).join(' ')).not.toContain('INCIDENT 8');
  });

  it('an empty needle matches nothing rather than everything', () => {
    // A blank entry in a needle list would otherwise report every line in the
    // document, which is the loudest possible false positive.
    expect(findStrings('any line at all\nand another', ['', 'nope'], 'r')).toEqual([]);
  });

  it('requires enough prefix for a prefix match to mean anything', () => {
    expect(prefixMatch('CHAPTER 9 — Identity', 'CHAPTER 9')).toBe(true);
    // Below the floor only exact equality counts — otherwise '' matches all.
    expect(prefixMatch('CHAPTER 9 — Identity', '')).toBe(false);
    expect(prefixMatch('CHAPTER 9 — Identity', 'CHA')).toBe(false);
    expect(prefixMatch('abc', 'abc')).toBe(true);
  });
});

describe('hygiene and coverage', () => {
  it('reports a heading holding a paragraph, and not a normal title', () => {
    const long = heading(`INCIDENT 2 — ${'x'.repeat(200)}`, 2);
    expect(paragraphHeadings([long, heading('CHAPTER 1 — System Overview & Stack', 1)])).toHaveLength(1);
  });

  it('reports coverage gaps BY NAME, never as a count', () => {
    const gaps = missingByName(['§128', '§129'], new Set(['§128']), 'r');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detail).toBe('§129');
  });
});
