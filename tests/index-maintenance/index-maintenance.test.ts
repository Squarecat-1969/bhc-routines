/**
 * Index maintenance — pure layers, no credentials.
 *
 * ⚠ FIXTURES ARE THE REAL LINES, copied from the live index and the live
 * September tab on 2026-09-05. The awkward parts ARE the logic: four different
 * term-header shapes, one of which carries a TRAILING SPACE that made 481 of
 * 640 headers invisible to the first version of this parser, and curly quotes
 * throughout that an anchor must not retype.
 */

import { describe, expect, it } from 'vitest';

import { SOURCE_ALIASES, SOURCE_TABS, latestSourceLabel } from '../../src/passes/index-maintenance/constants.js';
import {
  PLAN_LOCATOR_MAX,
  excerptFor,
  headingUrlsByLocator,
  parseIndexTab,
  parsePlanSections,
  parseSourceTab,
  planLocator,
  planLocatorMatches,
} from '../../src/passes/index-maintenance/parse.js';
import {
  PLAN_STATE_HEADER,
  contentHash,
  driftOf,
  nextStateFor,
  parsePlanStateRow,
  provenanceFor,
  reconcilePlanState,
  serializePlanStateRow,
} from '../../src/passes/index-maintenance/plan-state.js';
import { anchorOf, type DocLink } from '../../src/lib/docs.js';
import { linksWithDeadAnchors } from '../../src/passes/docs-qc/checks.js';
import {
  buildVocabulary,
  buildWatermark,
  countLine,
  insertionIndexFor,
  planWrites,
  recount,
  referenceLine,
  unindexedEntries,
} from '../../src/passes/index-maintenance/plan.js';

/** Verbatim from GROUP: Failure classes and GROUP: Routines, 2026-09-05. */
const FAILURE_TAB = [
  'GROUP: Failure classes',
  'auth bypass  (1 reference)',
  '· §041 · 2026-08-08 · Log “after this session Shipped and merged: workflow graphic (§60), auth bypass closed (§63)”',
  'dedup gap  (2 references)',
  '· §008 · 2026-06-02 · Log “Three issues found: topically-blind matching, circular Fathom matches, cross-chunk dedup gap.”',
  '· 5.9 · Plan “· Trigger: manual/API and cron respectively · Status: LIVE, known dedup gap”',
  'stale spec  (1 reference)',
  '· 8.6 · Plan “at K where Severity really lives. Code written against that stale spec caused a near-miss”',
].join('\n');

/**
 * ⚠ THE TRAILING SPACE AFTER `)` IS REAL AND DELIBERATE IN THIS FIXTURE.
 * Every high-frequency header in the live document carries one.
 */
const ROUTINES_TAB = [
  'GROUP: Routines',
  'Late Edition  (197 references) ',
  "high-frequency; appears throughout this group's sources, not individually indexed below the cap.",
  'minting  (26 references, showing 23 of 26)',
  '· §074 · 2026-08-19 · Log “A duplicate identity is a human judgment call”',
  'Contacts Triage  (3 references)',
  '· §117 · 2026-09-01 · Log “Suppression against prior human decisions”',
].join('\n');

const ADDITIONAL_TAB = [
  'ADDITIONAL TERMS',
  'Terms below are alphabetical. Each term shows every source-tab location where it occurs.',
  'Accept-handler  (11 occurrences across 1 tabs)',
  '· §031.1 · 2026-07-18 · Log — 11 occurrences',
  '    While PASS 1 and PASS 0 were being built in this session, a cross-repo dependency was flagged.',
].join('\n');

const SEPTEMBER = [
  '§106 — Calendar evidence: Google tried, abandoned, and why · 2026-09-01',
  'The Calendar route was built and then abandoned because attendee resolution',
  'returned zero contacts on every path measured.',
  '',
  '§117 — Suppression against prior human decisions · 2026-09-01 · 49cb8ef',
  'Raymond Yang was scrapped on 2026-08-05 and Attio re-created him twice.',
  // ⚠ A cross-reference that reproduces the HEADING SHAPE mid-sentence,
  // em-dash and all. This is the line that makes the ^ anchor load-bearing;
  // without one, a bare "§092 and §096" cannot tell the two patterns apart.
  'Same shape as §092 — the fixture failure — and as §096 later that week.',
].join('\n');

const failure = () => parseIndexTab('t.fail', 'GROUP: Failure classes', FAILURE_TAB);
const routines = () => parseIndexTab('t.rout', 'GROUP: Routines', ROUTINES_TAB);
const additional = () => parseIndexTab('t.add', 'ADDITIONAL TERMS', ADDITIONAL_TAB);

describe('parseIndexTab', () => {
  it('parses the plain term shape with its references', () => {
    const t = failure();
    expect(t.terms.map((x) => x.term)).toEqual(['auth bypass', 'dedup gap', 'stale spec']);
    expect(t.terms[1]!.declaredCount).toBe(2);
    expect(t.terms[1]!.references.map((r) => r.locator)).toEqual(['§008', '5.9']);
    expect(t.terms[1]!.references[1]!.source).toBe('Plan');
    // Only the title line is unparsed.
    expect(t.unparsedLines).toHaveLength(1);
  });

  // ⚠⚠ THE BUG THIS FILE EXISTS FOR.
  it('parses a HIGH-FREQUENCY header despite its TRAILING SPACE', () => {
    // Anchoring the count on `$` silently failed to match 481 of 640 live
    // headers. An unmatched header is indistinguishable from an absent term,
    // so the entire controlled vocabulary would have been re-proposed as new.
    const t = routines();
    const late = t.terms.find((x) => x.term === 'Late Edition');
    expect(late).toBeDefined();
    expect(late!.declaredCount).toBe(197);
    expect(late!.highFrequency).toBe(true);
    expect(late!.capped).toBe(true);
  });

  it('parses a Rule A capped header and keeps its shown-count', () => {
    const minting = routines().terms.find((x) => x.term === 'minting')!;
    expect(minting.declaredCount).toBe(26);
    expect(minting.shownCount).toBe(23);
    expect(minting.capped).toBe(true);
  });

  it('parses ADDITIONAL TERMS\' occurrence form, and does NOT read its tab count as a cap', () => {
    const t = additional();
    const term = t.terms.find((x) => x.term === 'Accept-handler')!;
    expect(term.declaredCount).toBe(11);
    // `across 1 tabs` is a tab count. Reading it as a Rule A shown-count would
    // mark every ADDITIONAL term capped and suppress every reference line.
    expect(term.shownCount).toBeNull();
    expect(term.capped).toBe(false);
    expect(term.references.map((r) => r.locator)).toEqual(['§031.1']);
  });
});

describe('parseSourceTab', () => {
  it('finds entries by their heading only', () => {
    const entries = parseSourceTab(SEPTEMBER);
    expect(entries.map((e) => e.locator)).toEqual(['§106', '§117']);
  });

  it('⚠ does NOT treat a mid-sentence cross-reference as an entry', () => {
    // The log cites itself constantly, and it cites itself in the SAME SHAPE
    // as a heading — "§092 — the fixture failure". Only the start-of-line
    // anchor separates them; a looser pattern turns every cross-reference into
    // a phantom entry, and phantom entries get indexed.
    const entries = parseSourceTab(SEPTEMBER);
    expect(entries.map((e) => e.locator)).toEqual(['§106', '§117']);
    expect(entries.map((e) => e.locator)).not.toContain('§092');
    expect(entries.map((e) => e.locator)).not.toContain('§096');
  });

  it('takes the date from the heading', () => {
    expect(parseSourceTab(SEPTEMBER)[1]!.date).toBe('2026-09-01');
  });

  it('quotes the source verbatim rather than paraphrasing it', () => {
    const e = parseSourceTab(SEPTEMBER)[0]!;
    const excerpt = excerptFor(e, 60);
    expect(SEPTEMBER.replace(/\s+/g, ' ')).toContain(excerpt);
  });
});

describe('the watermark', () => {
  it('is derived from the index, and counts only Log references', () => {
    const wm = buildWatermark([failure(), routines()]);
    expect(wm.has('§041')).toBe(true);
    expect(wm.has('§008')).toBe(true);
    expect(wm.has('§117')).toBe(true);
    // Plan sections are not entry locators.
    expect(wm.has('5.9')).toBe(false);
    expect(wm.has('8.6')).toBe(false);
  });

  // ⚠⚠ WITHOUT THIS, EVERY RUN RE-JUDGES THE WHOLE CORPUS.
  it('excludes an entry the index already references', () => {
    const wm = buildWatermark([failure(), routines()]);
    const pending = unindexedEntries(parseSourceTab(SEPTEMBER), wm);
    // §117 is already referenced under "Contacts Triage"; §106 is not.
    expect(pending.map((e) => e.locator)).toEqual(['§106']);
  });

  it('sees references on ADDITIONAL TERMS too', () => {
    expect(buildWatermark([additional()]).has('§031.1')).toBe(true);
  });
});

describe('recount', () => {
  it('preserves a high-frequency header\'s TRAILING SPACE', () => {
    const late = routines().terms.find((x) => x.term === 'Late Edition')!;
    expect(recount(late, 198)).toBe('Late Edition  (198 references) ');
  });

  it('preserves a Rule A header\'s showing-clause', () => {
    const minting = routines().terms.find((x) => x.term === 'minting')!;
    expect(recount(minting, 27)).toBe('minting  (27 references, showing 23 of 27)');
  });

  it('keeps the plain shape plain, and singularises at one', () => {
    const auth = failure().terms.find((x) => x.term === 'auth bypass')!;
    expect(recount(auth, 2)).toBe('auth bypass  (2 references)');
    expect(countLine('x', 1)).toBe('x  (1 reference)');
  });
});

describe('referenceLine', () => {
  it('matches the index\'s own shape, with curly quotes', () => {
    const e = parseSourceTab(SEPTEMBER)[0]!;
    const line = referenceLine(e, 40);
    expect(line.startsWith('· §106 · 2026-09-01 · Log “')).toBe(true);
    expect(line.endsWith('”')).toBe(true);
  });

  // ⚠⚠ NOTHING IS ESCAPED. See src/lib/docs.ts.
  it('writes identifiers LITERALLY — no backslashes, ever', () => {
    // The transport writes literal bytes and never renders markdown, so
    // escaping does not protect `bhc_contact_id`; it STORES
    // `bhc\_contact\_id`. This routine writes such terms constantly.
    const entry = parseSourceTab(
      '§200 — Attio fields · 2026-09-05\nbhc_contact_id and last_email_interaction are *both* empty.',
    )[0]!;
    const line = referenceLine(entry, 120);
    expect(line).toContain('bhc_contact_id');
    expect(line).toContain('last_email_interaction');
    expect(line).toContain('*both*');
    expect(line).not.toContain('\\');
  });
});

describe('planWrites', () => {
  const setup = (terms: string[], proposed: string[] = []) => {
    const tabs = [failure(), routines(), additional()];
    const tabsById = new Map(tabs.map((t) => [t.tabId, t]));
    const vocabulary = buildVocabulary([failure(), routines()]);
    const entry = parseSourceTab(SEPTEMBER)[0]!;
    return planWrites({
      assignments: [{ entry, terms, proposedTerms: proposed }],
      vocabulary,
      tabsById,
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
  };

  it('inserts a reference and updates the count exactly once', () => {
    const plan = setup(['dedup gap']);
    const inserts = plan.writes.filter((w) => w.kind === 'insert-reference');
    const counts = plan.writes.filter((w) => w.kind === 'update-count');
    expect(inserts).toHaveLength(1);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.kind === 'update-count' && counts[0]!.toLine).toBe('dedup gap  (3 references)');
    // ⚠ THE ANCHOR IS THE LAST **Log** REFERENCE, NOT THE LAST REFERENCE.
    // The document orders Log references by date and then Plan references;
    // appending at the very end would file a September Log entry after a Plan
    // section, which is the only place that convention is visible.
    const anchor = inserts[0]!.kind === 'insert-reference' ? inserts[0]!.afterLine : '';
    expect(anchor).toContain('· §008 · 2026-06-02 · Log');
    expect(anchor).not.toContain('· 5.9 · Plan');
  });

  // ⚠⚠ RULE A / RULE B — AND THE IDEMPOTENCY THAT FOLLOWS FROM IT.
  it('writes NOTHING AT ALL for a high-frequency term, not even a count bump', () => {
    // A capped count cannot be bumped idempotently: nothing in the document
    // records which entries contributed to it, so a second run cannot tell an
    // already-counted entry from a new one and would add the same N again.
    // Stale by omission is recoverable; drifting upward every run is not.
    const plan = setup(['Late Edition']);
    expect(plan.writes).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain('high-frequency');
    expect(plan.warnings.join(' ')).toContain('NOTHING WAS WRITTEN');
  });

  it('does the same for a Rule A capped term', () => {
    const plan = setup(['minting']);
    expect(plan.writes).toHaveLength(0);
  });

  // ⚠⚠ THE FIX FOR THE 2026-09-05 PARTIAL RUN.
  it('derives a count from the references that will EXIST, not from a delta', () => {
    // An inflated count — 9 claimed where 2 references exist — is repaired
    // rather than compounded, which is what makes a re-run after a partial
    // failure safe.
    const inflated = parseIndexTab(
      't.fail',
      'GROUP: Failure classes',
      [
        'GROUP: Failure classes',
        'dedup gap  (9 references)',
        '· §008 · 2026-06-02 · Log “a”',
        '· §012 · 2026-06-09 · Log “b”',
      ].join('\n'),
    );
    const plan = planWrites({
      assignments: [{ entry: parseSourceTab(SEPTEMBER)[0]!, terms: ['dedup gap'], proposedTerms: [] }],
      vocabulary: buildVocabulary([inflated]),
      tabsById: new Map([['t.fail', inflated]]),
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
    const count = plan.writes.find((w) => w.kind === 'update-count')!;
    expect(count.kind === 'update-count' && count.toLine).toBe('dedup gap  (3 references)');
  });

  // ⚠⚠ THE DEFECT THAT SKIPPED 38 OF 150 LIVE WRITES.
  it('extends an anchor until it is UNIQUE within the tab', () => {
    // One entry legitimately appears under several terms in one tab, so its
    // reference line is IDENTICAL in each. Anchoring the next insert on that
    // line returns "appears 2 times ... Extend the string until it is unique."
    const tab = parseIndexTab(
      't.dup',
      'GROUP: Concepts & mechanisms',
      [
        'GROUP: Concepts & mechanisms',
        'alpha  (1 reference)',
        '· §900 · 2026-01-01 · Log “same text”',
        'beta  (1 reference)',
        '· §900 · 2026-01-01 · Log “same text”',
      ].join('\n'),
    );
    const plan = planWrites({
      assignments: [{ entry: parseSourceTab(SEPTEMBER)[0]!, terms: ['alpha', 'beta'], proposedTerms: [] }],
      vocabulary: buildVocabulary([tab]),
      tabsById: new Map([['t.dup', tab]]),
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
    const inserts = plan.writes.filter((w) => w.kind === 'insert-reference');
    expect(inserts).toHaveLength(2);
    for (const w of inserts) {
      const a = w.kind === 'insert-reference' ? w.afterLine : '';
      // Each anchor carries its term header, which is what makes it unique.
      expect(a.split('\n').length).toBeGreaterThan(1);
    }
    const anchors = inserts.map((w) => (w.kind === 'insert-reference' ? w.afterLine : ''));
    expect(new Set(anchors).size).toBe(2);
  });

  // ⚠⚠ THE VOCABULARY IS CONTROLLED.
  it('NEVER creates a new term in a GROUP tab — it proposes it in ADDITIONAL TERMS', () => {
    const plan = setup([], ['calendar attendee resolution']);
    const proposals = plan.writes.filter((w) => w.kind === 'insert-term');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.tabTitle).toBe('ADDITIONAL TERMS');
    expect(proposals[0]!.kind === 'insert-term' && proposals[0]!.text).toContain('PROPOSED TERM');
    expect(proposals[0]!.kind === 'insert-term' && proposals[0]!.text).toContain('NOT adopted');
    // Nothing was added to a GROUP tab.
    expect(plan.writes.some((w) => w.tabTitle.startsWith('GROUP:'))).toBe(false);
  });

  it('does NOT re-propose a term that is already in the vocabulary', () => {
    // The model routinely lists a real term under `proposedTerms` as well.
    // Taking that at face value files a PROPOSED TERM block for a term the
    // index already carries — noise in the one tab a human has to read.
    const plan = setup(['dedup gap'], ['dedup gap', 'stale spec']);
    expect(plan.writes.filter((w) => w.kind === 'insert-term')).toHaveLength(0);
  });

  it('routes an off-vocabulary term to proposals even when the model called it a term', () => {
    const plan = setup(['not a real term']);
    expect(plan.writes.filter((w) => w.kind === 'insert-term')).toHaveLength(1);
    expect(plan.warnings.join(' ')).toContain('not in the controlled vocabulary');
  });

  it('is IDEMPOTENT: an entry already referenced produces no write', () => {
    const tabs = [failure(), routines(), additional()];
    const entry = parseSourceTab(SEPTEMBER)[1]!; // §117, already under Contacts Triage
    const plan = planWrites({
      assignments: [{ entry, terms: ['Contacts Triage'], proposedTerms: [] }],
      vocabulary: buildVocabulary([failure(), routines()]),
      tabsById: new Map(tabs.map((t) => [t.tabId, t])),
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
    expect(plan.writes).toHaveLength(0);
  });

  it('stacks two entries on one term into ONE count update', () => {
    const tabs = [failure(), routines(), additional()];
    const entries = parseSourceTab(SEPTEMBER);
    const plan = planWrites({
      assignments: entries.map((entry) => ({ entry, terms: ['dedup gap'], proposedTerms: [] })),
      vocabulary: buildVocabulary([failure(), routines()]),
      tabsById: new Map(tabs.map((t) => [t.tabId, t])),
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
    expect(plan.writes.filter((w) => w.kind === 'insert-reference')).toHaveLength(2);
    const counts = plan.writes.filter((w) => w.kind === 'update-count');
    expect(counts).toHaveLength(1);
    expect(counts[0]!.kind === 'update-count' && counts[0]!.toLine).toBe('dedup gap  (4 references)');
    // The second insert anchors on the FIRST insert's line, not the stale one.
    const inserts = plan.writes.filter((w) => w.kind === 'insert-reference');
    expect(inserts[1]!.kind === 'insert-reference' && inserts[1]!.afterLine).toBe(
      inserts[0]!.kind === 'insert-reference' ? inserts[0]!.text : '',
    );
  });

  it('cannot express a wholesale replacement', () => {
    // Structural, not a rule in a comment: PlannedWrite has three shapes and
    // none of them replaces a tab. The transport refuses one too.
    const plan = setup(['dedup gap']);
    for (const w of plan.writes) {
      expect(['insert-reference', 'update-count', 'insert-term']).toContain(w.kind);
    }
  });
});

describe('the scheduled run\'s scope', () => {
  // ⚠ THE WEEKLY SAFETY NET RUNS `--latest-source`, AND THAT MUST FOLLOW THE
  // CALENDAR WITHOUT ANYONE EDITING A WORKFLOW. Naming a month in the
  // workflow would keep indexing September forever once October exists.
  it('is the LAST source tab, so a new month tab moves it automatically', () => {
    expect(latestSourceLabel()).toBe(SOURCE_TABS[SOURCE_TABS.length - 1]!.label);
  });

  it('resolves to a real, uniquely-labelled source', () => {
    const label = latestSourceLabel();
    expect(SOURCE_TABS.filter((s) => s.label === label)).toHaveLength(1);
    const tab = SOURCE_TABS.find((s) => s.label === label)!;
    // ⚠ tabId is REQUIRED on every call — an empty one resolves to the FIRST
    // tab of the document and verifies clean.
    expect(tab.tabId).not.toBe('');
    expect(tab.documentId).not.toBe('');
  });

  it('gives every source a non-empty tabId — none may default to the first tab', () => {
    for (const s of SOURCE_TABS) {
      expect(s.tabId, `${s.label} has no tabId`).toMatch(/^t\./);
    }
  });

  it('keeps every --source alias pointing at a real label', () => {
    for (const [alias, label] of Object.entries(SOURCE_ALIASES)) {
      expect(SOURCE_TABS.some((s) => s.label === label), `alias "${alias}"`).toBe(true);
    }
  });
});

describe('linked references', () => {
  const HEADINGS = [
    { text: 'September 2026', url: 'https://x/#heading=h.tab', linkable: true },
    { text: '§106 — Calendar evidence: Google tried, abandoned, and why · 2026-09-01', url: 'https://docs.google.com/document/d/D/edit?tab=t.T#heading=h.aaa', linkable: true },
    { text: '§117 — Suppression against prior human decisions · 2026-09-01', url: 'https://docs.google.com/document/d/D/edit?tab=t.T#heading=h.bbb', linkable: true },
    { text: '§999 — No anchor · 2026-09-01', url: '', linkable: false },
  ];

  it('keys anchors by LOCATOR, never by array position', () => {
    // The headings array and the parsed entries are two independent walks of
    // the same tab, and the tab title is a heading too. Pairing by index would
    // mis-link every entry after the first non-entry heading.
    const m = headingUrlsByLocator(HEADINGS);
    expect(m.get('§106')).toBe('https://docs.google.com/document/d/D/edit?tab=t.T#heading=h.aaa');
    expect(m.get('§117')).toBe('https://docs.google.com/document/d/D/edit?tab=t.T#heading=h.bbb');
    expect(m.has('September 2026')).toBe(false);
  });

  it('omits a heading Google gave no anchor, rather than inventing one', () => {
    expect(headingUrlsByLocator(HEADINGS).has('§999')).toBe(false);
  });

  it('splits a reference exactly where the migrated lines split', () => {
    // `· [§NNN · DATE · Log](url) “excerpt”` — the bullet and the quotation
    // stay OUTSIDE the link, matching all 610 migrated references.
    const entry = { ...parseSourceTab(SEPTEMBER)[0]!, headingUrl: 'https://e/#h' };
    const plan = planWrites({
      assignments: [{ entry, terms: ['dedup gap'], proposedTerms: [] }],
      vocabulary: buildVocabulary([failure(), routines()]),
      tabsById: new Map([failure(), routines(), additional()].map((t) => [t.tabId, t])),
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
    const ref = plan.writes.find((w) => w.kind === 'insert-reference')!;
    const link = ref.kind === 'insert-reference' ? ref.link : null;
    expect(link).not.toBeNull();
    expect(link!.prefix).toBe('· ');
    expect(link!.linkText).toBe('§106 · 2026-09-01 · Log');
    expect(link!.suffix.startsWith(' “')).toBe(true);
    expect(link!.suffix.endsWith('”')).toBe(true);
    // The three runs reassemble into exactly the plain line.
    expect(`${link!.prefix}${link!.linkText}${link!.suffix}`).toBe(
      ref.kind === 'insert-reference' ? ref.text : '',
    );
    // ⚠ The link text must not swallow the quotation.
    expect(link!.linkText).not.toContain('“');
  });

  it('falls back to a PLAIN reference when the entry has no anchor', () => {
    // Written plain rather than linked to the wrong place.
    const entry = parseSourceTab(SEPTEMBER)[0]!; // headingUrl null
    const plan = planWrites({
      assignments: [{ entry, terms: ['dedup gap'], proposedTerms: [] }],
      vocabulary: buildVocabulary([failure(), routines()]),
      tabsById: new Map([failure(), routines(), additional()].map((t) => [t.tabId, t])),
      additionalTermsTabId: 't.add',
      today: '2026-09-05',
    });
    const ref = plan.writes.find((w) => w.kind === 'insert-reference')!;
    expect(ref.kind === 'insert-reference' && ref.link).toBeNull();
  });
});

// --- Plan indexing ----------------------------------------------------------

/**
 * ⚠ THE HEADING SHAPES ARE THE REAL ONES, read live 2026-09-08: numeric-token
 * headings (`5.3`, `8.11`), a lettered one (`3a`), a chapter-level L1 that is
 * NOT a unit, a blank page-break heading, and a paragraph-length L3 whose
 * heading text IS its body.
 */
function planFixture() {
  const body = (h: string, n: number) => `${h}\n${'x'.repeat(n)}\n`;
  const parts = [
    body('Ch 5 — Routines', 40), // L1, not a unit
    body('5.3 BHC Zoom', 300),
    body('5.10 Reconciler', 120),
    body('', 10), // blank page-break heading, skipped
    body('OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT DONE YET', 250),
  ];
  const content = parts.join('');
  const headings: {
    headingId: string;
    level: number;
    text: string;
    plainTextStartIndex: number;
    linkable: boolean;
    url: string;
  }[] = [];
  let at = 0;
  const levels = [1, 2, 2, 2, 2];
  const texts = ['Ch 5 — Routines', '5.3 BHC Zoom', '5.10 Reconciler', '', 'OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT DONE YET'];
  parts.forEach((p, i) => {
    headings.push({
      headingId: `h.${i}`,
      level: levels[i]!,
      text: texts[i]!,
      plainTextStartIndex: at,
      linkable: true,
      url: `https://docs.google.com/document/d/PLAN/edit#heading=h.${i}`,
    });
    at += p.length;
  });
  return { content, headings };
}

describe('planLocator', () => {
  it('reproduces the numeric-token convention exactly', () => {
    expect(planLocator('5.3 BHC Zoom')).toBe('5.3');
    expect(planLocator('8.11 Attio — object & field schema')).toBe('8.11');
    expect(planLocator('3a Something')).toBe('3a');
  });

  it('truncates a text heading at a word boundary, within the measured 64', () => {
    const loc = planLocator('OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT DONE YET AND MORE BESIDES');
    expect(loc.length).toBeLessThanOrEqual(PLAN_LOCATOR_MAX);
    expect(loc.endsWith(' ')).toBe(false);
    expect('OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT DONE YET AND MORE BESIDES'.startsWith(loc)).toBe(true);
  });
});

describe('planLocatorMatches', () => {
  it('⚠ matches two DIFFERENT truncations of the same heading', () => {
    // This is the whole reason dedup is not equality: the 69 hand-written
    // locators were cut by eye at 48-64 characters.
    const hand = 'OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT';
    const generated = 'OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT DONE YET';
    expect(planLocatorMatches(hand, generated)).toBe(true);
  });

  it('⚠ NEVER conflates 5.1 with 5.10 — the length floor is what holds this shut', () => {
    expect(planLocatorMatches('5.1', '5.10')).toBe(false);
    expect(planLocatorMatches('8.1', '8.11')).toBe(false);
    expect(planLocatorMatches('5.3', '5.3')).toBe(true);
  });

  it('refuses a prefix match too short to identify a section', () => {
    expect(planLocatorMatches('Backlogs', 'Backlogs and other things')).toBe(false);
  });
});

describe('parsePlanSections', () => {
  const { content, headings } = planFixture();
  const units = () => parsePlanSections(content, headings, { maxChars: 20000 });

  it('takes L2/L3 headings only — a chapter is its sub-sections', () => {
    expect(units().map((u) => u.locator)).toEqual(['5.3', '5.10', 'OPERATIONAL BACKLOGS AND THE THINGS THAT ARE NOT DONE YET']);
  });

  it('skips the blank page-break heading', () => {
    expect(units().some((u) => u.locator === '')).toBe(false);
  });

  it('runs a unit to the next heading of ANY level, and marks it Plan', () => {
    const u = units()[0]!;
    expect(u.sourceKind).toBe('Plan');
    expect(u.body).toContain('5.3 BHC Zoom');
    expect(u.body).not.toContain('5.10 Reconciler');
  });

  it('⚠ FLAGS A TRUNCATED UNIT AND KEEPS ITS TRUE LENGTH — a partial read is never silent', () => {
    const small = parsePlanSections(content, headings, { maxChars: 50 });
    const u = small.find((x) => x.locator === '5.3')!;
    expect(u.truncatedTo).toBe(50);
    expect(u.body.length).toBe(50);
    expect(u.fullLength).toBeGreaterThan(50);
    // The hash is taken from the WHOLE unit, never the slice the model saw.
    expect(u.fullBody!.length).toBe(u.fullLength);
  });

  it('leaves truncatedTo undefined when the whole unit was read', () => {
    for (const u of units()) expect(u.truncatedTo).toBeUndefined();
  });
});

describe('the Plan reference line', () => {
  it("says `Plan`, not `Log`, and carries no date", () => {
    const u = parsePlanSections(planFixture().content, planFixture().headings, { maxChars: 20000 })[0]!;
    const line = referenceLine(u, 40);
    expect(line.startsWith('· 5.3 · Plan “')).toBe(true);
    expect(line).not.toContain('· Log ');
  });
});

describe('insertionIndexFor', () => {
  const tab = parseIndexTab('t.fail', 'GROUP: Failure classes', FAILURE_TAB);
  const lines = FAILURE_TAB.split('\n');
  const dedup = tab.terms.find((t) => t.term === 'dedup gap')!;

  it('files a LOG reference after the last Log line, above the Plan block', () => {
    const at = insertionIndexFor(lines, dedup, 'Log');
    expect(lines[at]).toContain('· §008 ');
  });

  it('⚠ files a PLAN reference at the END of the block, never above the hand-written ones', () => {
    const at = insertionIndexFor(lines, dedup, 'Plan');
    expect(lines[at]).toContain('· 5.9 · Plan ');
  });
});

describe('contentHash and drift', () => {
  it('is stable under a reflow, and moves when the text does', () => {
    expect(contentHash('one two\nthree')).toBe(contentHash('one  two   three'));
    expect(contentHash('one two three')).not.toBe(contentHash('one two four'));
  });

  it('classifies unseen / unchanged / CHANGED', () => {
    const prior = {
      locator: '5.3',
      headingId: 'h.1',
      contentHash: 'aaaa',
      unitChars: 10,
      truncatedTo: 0,
      indexedBy: 'hand' as const,
      firstSeen: '2026-09-08',
      lastSeen: '2026-09-08',
      liveAnchor: '',
    };
    expect(driftOf(undefined, 'aaaa')).toBe('unseen');
    expect(driftOf(prior, 'aaaa')).toBe('unchanged');
    expect(driftOf(prior, 'bbbb')).toBe('CHANGED');
  });
});

describe('Plan_Index_State rows', () => {
  it('⚠ reads an UNRECOGNISED provenance as `hand`, never as `routine`', () => {
    // The permissive direction would let the routine believe it owns
    // references a human wrote — and all 291 existing ones are human.
    expect(parsePlanStateRow(['5.3', 'h.1', 'aaaa', '10', '0', '', '2026-09-08', '2026-09-08'])!.indexedBy).toBe('hand');
    expect(parsePlanStateRow(['5.3', 'h.1', 'aaaa', '10', '0', 'ROUTINE?', '2026-09-08', '2026-09-08'])!.indexedBy).toBe('hand');
    expect(parsePlanStateRow(['5.3', 'h.1', 'aaaa', '10', '0', 'routine', '2026-09-08', '2026-09-08'])!.indexedBy).toBe('routine');
  });

  it('round-trips through the header order', () => {
    const row = serializePlanStateRow({
      locator: '5.3',
      headingId: 'h.1',
      contentHash: 'abc',
      unitChars: 300,
      truncatedTo: 0,
      indexedBy: 'routine',
      firstSeen: '2026-09-08',
      lastSeen: '2026-09-09',
      liveAnchor: '',
    });
    expect(row).toHaveLength(PLAN_STATE_HEADER.length);
    expect(parsePlanStateRow(row.map(String))!.unitChars).toBe(300);
  });
});

// --- Reconciliation: four classes on two keys -------------------------------

const st = (o: Partial<Parameters<typeof serializePlanStateRow>[0]>) => ({
  locator: 'x', headingId: 'h.x', contentHash: 'aaaa', unitChars: 10, truncatedTo: 0,
  indexedBy: 'routine' as const, firstSeen: '2026-09-07', lastSeen: '2026-09-07', liveAnchor: '', ...o,
});
const live = (o: Partial<{ locator: string; headingId: string; contentHash: string; unitChars: number; truncatedTo: number }>) => ({
  locator: 'x', headingId: 'h.x', contentHash: 'aaaa', unitChars: 10, truncatedTo: 0, ...o,
});

describe('reconcilePlanState', () => {
  it('ALIVE when both keys agree', () => {
    const r = reconcilePlanState([st({})], [live({})], planLocatorMatches);
    expect(r.alive.map((x) => x.prior.locator)).toEqual(['x']);
    expect([r.renamed, r.anchorChanged, r.gone, r.fresh].every((a) => a.length === 0)).toBe(true);
  });

  it('RENAMED when the id holds and the locator moved', () => {
    const r = reconcilePlanState(
      [st({ locator: 'OPERATIONAL BACKLOGS — these are the two queues', headingId: 'h.ob' })],
      [live({ locator: 'OPERATIONAL BACKLOGS — this is the only queue', headingId: 'h.ob' })],
      planLocatorMatches,
    );
    expect(r.renamed).toHaveLength(1);
    expect(r.gone).toHaveLength(0);
    // ⚠ THE REGRESSION THAT MATTERS: locator-only matching reported this one
    // section as GONE *and* NEW in the same run.
    expect(r.fresh).toHaveLength(0);
  });

  it('⚠ ANCHOR CHANGED when the paragraph was retyped — same text, new id', () => {
    // INCIDENT 2, 2026-09-07: h.lagfoh7a5rp3 -> h.cmytyawr14t8.
    const r = reconcilePlanState(
      [st({ locator: 'INCIDENT 2 — The gap-row deletion', headingId: 'h.lagfoh7a5rp3' })],
      [live({ locator: 'INCIDENT 2 — The gap-row deletion', headingId: 'h.cmytyawr14t8' })],
      planLocatorMatches,
    );
    expect(r.anchorChanged).toHaveLength(1);
    expect(r.alive).toHaveLength(0);
    expect(r.gone).toHaveLength(0);
  });

  it('GONE only when NEITHER key matches', () => {
    const r = reconcilePlanState([st({ locator: 'ROOT CAUSE — a fragment', headingId: 'h.gone' })], [live({ locator: '5.3', headingId: 'h.53' })], planLocatorMatches);
    expect(r.gone.map((x) => x.prior.locator)).toEqual(['ROOT CAUSE — a fragment']);
    expect(r.fresh.map((x) => x.locator)).toEqual(['5.3']);
  });

  it('⚠ matches the strong key FIRST, so a prefix match cannot steal a section', () => {
    const prior = [st({ locator: 'INCIDENT 7 — Part D wrote into Tasks_Open', headingId: 'h.i7' }), st({ locator: 'INCIDENT 7 — Part D', headingId: 'h.other' })];
    const r = reconcilePlanState(prior, [live({ locator: 'INCIDENT 7 — Part D wrote into Tasks_Open', headingId: 'h.i7' })], planLocatorMatches);
    expect(r.alive.map((x) => x.prior.headingId)).toEqual(['h.i7']);
    expect(r.gone.map((x) => x.prior.headingId)).toEqual(['h.other']);
  });

  it('reports content drift on a live section', () => {
    const r = reconcilePlanState([st({ contentHash: 'OLD' })], [live({ contentHash: 'NEW' })], planLocatorMatches);
    expect(r.alive[0]!.drift).toBe('CHANGED');
  });
});

describe('nextStateFor', () => {
  const rec = (cls: 'ALIVE' | 'ANCHOR_CHANGED' | 'GONE', prior: ReturnType<typeof st>, liveS: ReturnType<typeof live> | null) =>
    ({ cls, prior, live: liveS, drift: 'unchanged' as const });

  it('⚠ on ANCHOR CHANGED keeps the OLD heading_id and records the new one as superseded', () => {
    // The report must stay truthful about the INDEX: the reference lines still
    // point at the dead anchor, so that is what the row must keep saying.
    const out = nextStateFor(
      rec('ANCHOR_CHANGED', st({ locator: 'INCIDENT 2', headingId: 'h.dead' }), live({ locator: 'INCIDENT 2', headingId: 'h.new', contentHash: 'NEW' })),
      '2026-09-08',
    );
    expect(out.headingId).toBe('h.dead');
    expect(out.liveAnchor).toBe('h.new');
    expect(out.contentHash).toBe('NEW'); // the hash DOES move
    expect(out.lastSeen).toBe('2026-09-08');
  });

  it('on ALIVE takes the live anchor and leaves superseded_anchor blank', () => {
    const out = nextStateFor(rec('ALIVE', st({}), live({ contentHash: 'NEW' })), '2026-09-08');
    expect(out.headingId).toBe('h.x');
    expect(out.liveAnchor).toBe('');
    expect(out.contentHash).toBe('NEW');
  });

  it('⚠ returns a GONE row UNCHANGED — last_seen is not bumped for a day it was absent', () => {
    const prior = st({ lastSeen: '2026-09-07' });
    expect(nextStateFor(rec('GONE', prior, null), '2026-09-08')).toEqual(prior);
  });

  it('preserves provenance across every class', () => {
    const out = nextStateFor(rec('ANCHOR_CHANGED', st({ indexedBy: 'hand' }), live({ headingId: 'h.new' })), '2026-09-08');
    expect(out.indexedBy).toBe('hand');
  });
});

describe('anchorOf — both stored link forms', () => {
  it('reads url form, with its document and tab', () => {
    const a = anchorOf({
      text: '§006', form: 'url', startIndex: 0, endIndex: 1, plainTextStartIndex: 0, plainTextEndIndex: 1,
      link: { url: 'https://docs.google.com/document/d/DOC1/edit?tab=t.abc#heading=h.xq97war9gbqh' },
    })!;
    expect(a).toMatchObject({ headingId: 'h.xq97war9gbqh', tabId: 't.abc', documentId: 'DOC1' });
  });

  it('⚠ reads HEADING form — the shape a human makes in the Docs UI', () => {
    // Reading only `link.url` reported three of these as dead on 2026-09-08.
    const a = anchorOf({
      text: 'INCIDENT 8', form: 'heading', startIndex: 0, endIndex: 1, plainTextStartIndex: 0, plainTextEndIndex: 1,
      link: { heading: { id: 'h.js0m56ksigiv', tabId: 't.6r0bmznlg6id' } },
    })!;
    expect(a.headingId).toBe('h.js0m56ksigiv');
    // ⚠ Intra-document: it carries no document ID and must not invent one.
    expect(a.documentId).toBeNull();
  });

  it('returns null for a link naming no heading', () => {
    expect(anchorOf({ text: 'x', form: 'url', startIndex: 0, endIndex: 1, plainTextStartIndex: 0, plainTextEndIndex: 1, link: { url: 'https://example.com' } })).toBeNull();
  });
});

describe('linksWithDeadAnchors', () => {
  const anchors = new Map([['IDX', new Set(['h.self'])], ['DOC1', new Set(['h.alive'])]]);
  const mk = (over: Partial<DocLink>): DocLink => ({ text: 't', form: 'url', startIndex: 0, endIndex: 1, plainTextStartIndex: 0, plainTextEndIndex: 1, link: {}, ...over }) as DocLink;
  const run = (links: DocLink[]) => linksWithDeadAnchors({ tabTitle: 'GROUP: x', links, anchorsByDocument: anchors, ownDocumentId: 'IDX', ruleId: 'index-link-targets-resolve' });

  it('passes a live anchor and fires on a dead one', () => {
    expect(run([mk({ link: { url: 'https://docs.google.com/document/d/DOC1/edit#heading=h.alive' } })])).toHaveLength(0);
    expect(run([mk({ link: { url: 'https://docs.google.com/document/d/DOC1/edit#heading=h.dead' } })])).toHaveLength(1);
  });

  it('⚠ resolves a HEADING-form link against its OWN document, not a guessed one', () => {
    expect(run([mk({ form: 'heading', link: { heading: { id: 'h.self' } } })])).toHaveLength(0);
    expect(run([mk({ form: 'heading', link: { heading: { id: 'h.nope' } } })])).toHaveLength(1);
  });

  it('⚠ REPORTS an unrecognised form rather than skipping it silently', () => {
    const f = run([mk({ form: 'bookmark', link: {} })]);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain('UNRECOGNISED LINK FORM');
  });

  it('reports a link into a document it has no anchors for', () => {
    expect(run([mk({ link: { url: 'https://docs.google.com/document/d/UNKNOWN/edit#heading=h.a' } })])[0]!.detail).toContain('UNKNOWN DOCUMENT');
  });
});

describe('provenanceFor — three states, and the one that must be observed', () => {
  it('⚠ becomes `routine` ONLY when lines actually landed', () => {
    expect(provenanceFor({ prior: null, referencedInIndex: false, wroteThisRun: true })).toBe('routine');
    // The defect this fixes: a --no-llm run created nine rows saying `routine`
    // having written no reference line at all.
    expect(provenanceFor({ prior: null, referencedInIndex: false, wroteThisRun: false })).toBe('unindexed');
  });

  it('a new section already referenced by someone else is `hand`', () => {
    expect(provenanceFor({ prior: null, referencedInIndex: true, wroteThisRun: false })).toBe('hand');
  });

  it('⚠ corrects a stored `routine` that nothing points at', () => {
    expect(provenanceFor({ prior: 'routine', referencedInIndex: false, wroteThisRun: false })).toBe('unindexed');
  });

  it('keeps a genuine `routine` that is still referenced', () => {
    expect(provenanceFor({ prior: 'routine', referencedInIndex: true, wroteThisRun: false })).toBe('routine');
  });

  it('promotes `unindexed` to `hand` when references appear that this run did not write', () => {
    expect(provenanceFor({ prior: 'unindexed', referencedInIndex: true, wroteThisRun: false })).toBe('hand');
  });

  it('⚠ NEVER DEMOTES `hand`, even with nothing pointing at it', () => {
    // Demoting opens a path back up to `routine` on a later run, letting the
    // routine claim ownership of references a human wrote.
    expect(provenanceFor({ prior: 'hand', referencedInIndex: false, wroteThisRun: false })).toBe('hand');
  });
});

describe('parsePlanStateRow — three values', () => {
  const row = (v: string) => parsePlanStateRow(['5.3', 'h.1', 'aaaa', '10', '0', v, '2026-09-08', '2026-09-08', ''])!.indexedBy;
  it('recognises all three', () => {
    expect(row('hand')).toBe('hand');
    expect(row('routine')).toBe('routine');
    expect(row('unindexed')).toBe('unindexed');
  });
  it('⚠ still reads anything unrecognised as `hand`, never `routine`', () => {
    expect(row('')).toBe('hand');
    expect(row('ROUTINE?')).toBe('hand');
    expect(row('unindexed?')).toBe('hand');
  });
});

describe('nextStateFor — the derived repair', () => {
  const anchorChanged = {
    cls: 'ANCHOR_CHANGED' as const,
    prior: st({ locator: 'INCIDENT 2', headingId: 'h.dead', liveAnchor: 'h.new' }),
    live: live({ locator: 'INCIDENT 2', headingId: 'h.new', contentHash: 'NEW' }),
    drift: 'unchanged' as const,
  };

  it('⚠ RESOLVES when the index no longer points at the dead anchor and does point at the live one', () => {
    const out = nextStateFor(anchorChanged, '2026-09-08', new Set(['h.new', 'h.other']));
    expect(out.headingId).toBe('h.new');
    expect(out.liveAnchor).toBe('');
  });

  it('⚠ does NOT resolve while the index still points at the dead anchor', () => {
    const out = nextStateFor(anchorChanged, '2026-09-08', new Set(['h.dead', 'h.new']));
    expect(out.headingId).toBe('h.dead');
    expect(out.liveAnchor).toBe('h.new');
  });

  it('does not resolve when the index points at neither — the repair was not observed', () => {
    const out = nextStateFor(anchorChanged, '2026-09-08', new Set(['h.unrelated']));
    expect(out.headingId).toBe('h.dead');
  });

  it('⚠ NEVER resolves on a null anchor set — an unread index is not evidence of repair', () => {
    // Passing null means the index was read without links. Closing the row
    // there would be declaring the repair rather than observing it.
    const out = nextStateFor(anchorChanged, '2026-09-08', null);
    expect(out.headingId).toBe('h.dead');
    expect(out.liveAnchor).toBe('h.new');
  });

  it('leaves a non-ANCHOR_CHANGED row alone even when the anchors would satisfy it', () => {
    const alive = { cls: 'ALIVE' as const, prior: st({ headingId: 'h.x' }), live: live({ headingId: 'h.x' }), drift: 'unchanged' as const };
    expect(nextStateFor(alive, '2026-09-08', new Set(['h.x'])).liveAnchor).toBe('');
  });
});
