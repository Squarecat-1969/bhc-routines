/** Constants for the index maintenance routine. Every measurement is dated. */

export function makeIndexRunId(now: Date = new Date()): string {
  return `INDEX-MAINT-${now.getTime()}`;
}

export const INDEX_DOC_ID = '1XDMVXmVAKd0q2uaUqRHk4_34J6nruzU8nmkqPSEcBuI';

/**
 * The nine index tabs, read live 2026-09-05 via `listTabs` rather than
 * transcribed from a brief. `t.0` is SOURCES INDEXED and is NOT a term tab.
 */
export const ADDITIONAL_TERMS_TAB = 't.floyr53yoysv';
export const SOURCES_INDEXED_TAB = 't.0';

/**
 * The GROUP tab whose terms satisfy §089.4's mandatory failure-class rule.
 * Read live 2026-09-05: 8 terms, 25 references.
 */
export const FAILURE_CLASSES_TAB = 't.g5olqeq90gjm';

export interface SourceTab {
  readonly label: string;
  readonly documentId: string;
  readonly tabId: string;
  /**
   * Measured preRead, with its date. Rule 8: a measurement is not a law, and
   * this corpus is the reason — §105 found character count predicts NOTHING
   * here (a 437k document reads in 637ms while log-002 at 327k takes 8,500ms).
   * Re-measure rather than extrapolating.
   */
  readonly measuredPreReadMs: number;
  readonly measuredOn: string;
}

/**
 * ⚠ VERIFIED 2026-09-05 AGAINST THE LIVE DOCUMENTS. The project instructions
 * describe log-001 as having a "Table of Contents" tab and a "Session Notes
 * (original)" tab. IT HAS NEITHER — it holds exactly the three month tabs
 * below. Do not build against the instructions' description.
 */
export const SOURCE_TABS: readonly SourceTab[] = [
  {
    label: "Developer's Plan",
    documentId: '1Hx1gXee4cltomMJbb2Z54etg4P1EO8VtRXURiYULDOI',
    tabId: 't.6r0bmznlg6id',
    measuredPreReadMs: 678,
    measuredOn: '2026-09-05',
  },
  { label: 'log-001 · May 2026', documentId: '1RuYdyhoaaL8xBfBIdvGoxgJ39gA-nxQaN9qx-I3lFX4', tabId: 't.ybpd957vf9sx', measuredPreReadMs: 1707, measuredOn: '2026-09-05' },
  { label: 'log-001 · June 2026', documentId: '1RuYdyhoaaL8xBfBIdvGoxgJ39gA-nxQaN9qx-I3lFX4', tabId: 't.eih8e5g59tms', measuredPreReadMs: 1707, measuredOn: '2026-09-05' },
  { label: 'log-001 · July 2026', documentId: '1RuYdyhoaaL8xBfBIdvGoxgJ39gA-nxQaN9qx-I3lFX4', tabId: 't.qygk8166n6kr', measuredPreReadMs: 1707, measuredOn: '2026-09-05' },
  {
    label: 'log-002 · August 2026 pt.1',
    documentId: '1gVUPxKAo19UyQN2isYuqfVuha3i6340gEylsVdX9Snw',
    // Read live 2026-09-05 via listTabs — the brief left this "read live".
    tabId: 't.1uy99kujmnqs',
    // ⚠ THE 3x OUTLIER, AND IT HAS DRIFTED. The brief carries 6,477ms; §105
    // measured 8,500ms the next day — thirteen times slower than a 437k
    // scratch document at a third the size. Budget for this one specifically.
    measuredPreReadMs: 8500,
    measuredOn: '2026-08-31',
  },
  { label: 'log-003 · August 2026 pt.2', documentId: '1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA', tabId: 't.hh7xro7j1cqz', measuredPreReadMs: 1244, measuredOn: '2026-09-05' },
  { label: 'log-003 · September 2026', documentId: '1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA', tabId: 't.jknmiezen1ga', measuredPreReadMs: 1771, measuredOn: '2026-09-05' },
];

/**
 * The newest source — the tab a session is currently writing into.
 *
 * ⚠ DERIVED FROM THE END OF `SOURCE_TABS`, NOT NAMED. A scheduled run must
 * follow the current month without anyone remembering to edit a workflow; the
 * list is maintained in chronological order, so adding a new month tab moves
 * this automatically. Naming a month here would silently keep indexing
 * September forever.
 */
export function latestSourceLabel(): string {
  return SOURCE_TABS[SOURCE_TABS.length - 1]!.label;
}

/**
 * ⚠ `plan` IS A THIRD EXPLICIT SCOPE AND IS NEVER REACHABLE FROM THE WEEKLY
 * SCHEDULE. The Plan is 89 indexable units against the September run's 22, and
 * a first pass is measured in tens of minutes — acquiring it by default is the
 * same failure as the log backlog: real spend on a corpus nobody is waiting on.
 */
export const PLAN_SOURCE_LABEL = "Developer's Plan";

/** `--source september` etc. The first live run indexes ONE tab, not the backlog. */
export const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  september: 'log-003 · September 2026',
  plan: "Developer's Plan",
  may: 'log-001 · May 2026',
  june: 'log-001 · June 2026',
  july: 'log-001 · July 2026',
  'august-1': 'log-002 · August 2026 pt.1',
  'august-2': 'log-003 · August 2026 pt.2',
};

/** How many entries one invocation will assign. A cost backstop, not a limit on the corpus. */
export const MAX_LLM_CALLS = 40;
export const LLM_CONCURRENCY = 4;
export const LLM_WAVE_PAUSE_MS = 400;

/** Excerpt length on a reference line, matching the existing index's ~150 chars. */
export const EXCERPT_CHARS = 150;
