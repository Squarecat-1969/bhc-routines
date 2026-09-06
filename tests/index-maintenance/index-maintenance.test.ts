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
  excerptFor,
  headingUrlsByLocator,
  parseIndexTab,
  parseSourceTab,
} from '../../src/passes/index-maintenance/parse.js';
import {
  buildVocabulary,
  buildWatermark,
  countLine,
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
