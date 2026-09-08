/**
 * The link audit's three load-bearing functions.
 *
 * ⚠ THE ANCHOR IS THE ONLY THING BETWEEN A CORRECT LINK AND A PERMANENT
 * MISLINK. Measured 2026-09-08, 59 of the 91 unlinked reference lines have a
 * byte-identical twin somewhere in the same tab, and `expectedText` cannot tell
 * them apart precisely because they are identical. If `anchorFor` ever returns
 * a non-unique anchor, the audit points a human — or one day a writer — at the
 * wrong term's line, and nothing downstream can notice.
 *
 * So the failing case here is not "an anchor is produced". It is "the anchor
 * produced is UNIQUE, and when none can be, the answer is null rather than a
 * plausible guess".
 */

import { describe, expect, it } from 'vitest';

import { anchorFor, linkedOffsets, targetTextFor, MAX_ANCHOR_LINES } from '../../src/passes/link-audit/index.js';

describe('targetTextFor — what should carry the link', () => {
  it('returns the locator run, without the bullet and without the trailing space', () => {
    // ⚠ MEASURED, NOT INVENTED. All 1,332 already-linked runs in the corpus are
    // `<locator> · <date> · Log|Plan`, sitting immediately after "· " and
    // stopping before the space that precedes the quotation.
    expect(targetTextFor('· §115 · 2026-09-04 · Log “The owned-domains exclusion”'))
      .toBe('§115 · 2026-09-04 · Log');
  });

  it('handles a Plan reference and a reference with no date', () => {
    expect(targetTextFor('· 5.9 · Plan “something”')).toBe('5.9 · Plan');
    expect(targetTextFor('· INCIDENT 7 · Plan “x”')).toBe('INCIDENT 7 · Plan');
  });

  it('never includes the bullet', () => {
    const t = targetTextFor('· §001 · 2026-05-01 · Log “x”');
    expect(t?.startsWith('·')).toBe(false);
    expect(t?.endsWith(' ')).toBe(false);
  });

  it('returns null for a line that is not a reference line', () => {
    for (const l of ['# GROUP: Routines', 'Late Edition  (4 references)', '', '· not a reference']) {
      expect(targetTextFor(l), l).toBeNull();
    }
  });
});

describe('linkedOffsets — which lines are already claimed', () => {
  it('marks exactly the covered range', () => {
    const cov = linkedOffsets('abcdefgh', [{ plainTextStartIndex: 2, plainTextEndIndex: 5 }]);
    expect(cov).toEqual([false, false, true, true, true, false, false, false]);
  });

  it('treats a PARTIALLY linked line as linked', () => {
    // ⚠ THE RIGHT TEST FOR "LEAVE IT ALONE". A line with any link is already
    // claimed; re-linking it is the case guard 3 exists to refuse. Requiring
    // full coverage would put already-linked lines back in the work list.
    const content = '· §001 · 2026-05-01 · Log “x”';
    const cov = linkedOffsets(content, [{ plainTextStartIndex: 2, plainTextEndIndex: 8 }]);
    expect(cov.slice(0, content.length).some(Boolean)).toBe(true);
  });

  it('tolerates a link range running past the content', () => {
    const cov = linkedOffsets('abc', [{ plainTextStartIndex: 1, plainTextEndIndex: 99 }]);
    expect(cov).toEqual([false, true, true]);
  });

  it('returns all-false when there are no links', () => {
    expect(linkedOffsets('abc', []).some(Boolean)).toBe(false);
  });
});

describe('anchorFor — the mislink guard', () => {
  /** Two byte-identical reference lines, distinguished only by what precedes them. */
  const lines = [
    'term one  (2 references)',
    '· §112 · 2026-09-01 · Log “first context”',
    '· §115 · 2026-09-04 · Log “identical”',
    'term two  (1 references)',
    '· §113 · 2026-09-02 · Log “second context”',
    '· §115 · 2026-09-04 · Log “identical”',
  ];
  const content = lines.join('\n');
  const target = '§115 · 2026-09-04 · Log';

  it('returns an anchor that appears exactly once before the target', () => {
    const a = anchorFor(content, lines, 2, target);
    expect(a).not.toBeNull();
    expect(content.split(a!.anchor + target).length - 1).toBe(1);
  });

  it('distinguishes the two identical lines from each other', () => {
    // ⚠ THE WHOLE POINT. Both lines are byte-identical; only the preceding
    // context separates them, and each must get its OWN anchor.
    const first = anchorFor(content, lines, 2, target)!;
    const second = anchorFor(content, lines, 5, target)!;
    expect(first.anchor).not.toBe(second.anchor);
    expect(content.indexOf(first.anchor + target)).toBeLessThan(content.indexOf(second.anchor + target));
  });

  it('ends with the bullet, so it is the text IMMEDIATELY before the target', () => {
    // The route's precededBy is literal and adjacent; an anchor that stopped at
    // the newline would never match.
    expect(anchorFor(content, lines, 2, target)!.anchor.endsWith('\n· ')).toBe(true);
  });

  it('grows the span only as far as it must', () => {
    const a = anchorFor(content, lines, 2, target)!;
    expect(a.lines).toBe(1);
  });

  it('returns NULL rather than a plausible guess when nothing disambiguates', () => {
    // ⚠ MUTATION TARGET. A fallback that returned the longest span it tried
    // would hand back an ambiguous anchor that reads as a real one — and a
    // mislink is permanent, because the line then carries a link and no later
    // run touches it.
    const repeated: string[] = [];
    for (let i = 0; i < 12; i++) repeated.push('· §115 · 2026-09-04 · Log “identical”');
    expect(anchorFor(repeated.join('\n'), repeated, 8, target)).toBeNull();
  });

  it('returns null at the very start of a tab, where nothing precedes it', () => {
    expect(anchorFor(content, lines, 0, target)).toBeNull();
  });

  it('never grows past the cap', () => {
    const a = anchorFor(content, lines, 5, target);
    expect(a === null || a.lines <= MAX_ANCHOR_LINES).toBe(true);
    expect(MAX_ANCHOR_LINES).toBe(6);
  });
});
