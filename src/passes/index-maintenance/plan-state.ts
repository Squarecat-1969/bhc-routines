/**
 * PER-LOCATOR CONTENT HASHES — the real deliverable of Plan indexing.
 *
 * ⚠ THIS IS BUILT EVEN THOUGH THE UPDATE HALF IS NOT AUTOMATED, and that is
 * deliberate. A log entry is appended and never changes, so "seen once" means
 * "done forever". A PLAN CHAPTER IS REWRITTEN IN PLACE — Chapters 1, 3, 4, 5.3
 * and 11 were substantially rewritten between 2026-08-25 and 08-27 while their
 * index references predate every one of those edits, and nothing noticed.
 *
 * The routine will not repair that (see docs/plan-indexing-spec.md §4: removing
 * a superseded reference needs a delete capability the transport deliberately
 * lacks, and a provenance record that cannot be retrofitted onto 291
 * hand-written references). What it CAN do is record what each section looked
 * like when it was indexed, so the QC pass can name the ones that have moved.
 *
 * A stale index that says which parts are stale is a different thing from a
 * stale index.
 */

import { createHash } from 'node:crypto';

import { cell, type SheetRow } from '../../lib/sheets.js';

export const PLAN_STATE_TAB = 'Plan_Index_State';
export const PLAN_STATE_RANGES = {
  header: `${PLAN_STATE_TAB}!A1:I1`,
  data: `${PLAN_STATE_TAB}!A2:I`,
} as const;

export const PLAN_STATE_HEADER = [
  'locator',
  'heading_id',
  'content_hash',
  'unit_chars',
  'truncated_to',
  'indexed_by',
  'first_seen',
  'last_seen',
  'live_anchor',
] as const;

export const PLAN_STATE_COLS = {
  locator: 0,
  headingId: 1,
  contentHash: 2,
  unitChars: 3,
  truncatedTo: 4,
  indexedBy: 5,
  firstSeen: 6,
  lastSeen: 7,
  liveAnchor: 8,
} as const;

export const PLAN_STATE_COLUMNS = PLAN_STATE_HEADER.length;

/**
 * ⚠ PROVENANCE, AND THE ONE VALUE THAT MAKES THE 291 SAFE.
 *
 * `hand` means: this section was already referenced in the index when the
 * routine first saw it, so a human wrote those references and the routine
 * cannot prove otherwise. Such a section is PERMANENTLY UNTOUCHABLE — the
 * routine records its hash for drift reporting and adds nothing.
 *
 * `routine` means: the routine added the references itself and could, in
 * principle, reason about them later. Nothing does yet.
 *
 * `unindexed` means: the section is TRACKED AND NOTHING POINTS AT IT. That is a
 * real, reportable condition, not an absence of one, and collapsing it into
 * either of the others loses the only way to ask which tracked sections have no
 * references. Eleven rows were in this state while claiming `routine`.
 *
 * ⚠ A ROW BECOMES `routine` ONLY WHEN REFERENCE LINES ACTUALLY LAND — never at
 * row creation. Setting it when a row is created records an INTENTION; this
 * column is supposed to record what happened. A `--no-llm` run created nine
 * rows saying `routine` on 2026-09-08 having written no reference line at all.
 * See `provenanceFor`.
 */
export type IndexedBy = 'hand' | 'routine' | 'unindexed';

export interface PlanSectionState {
  readonly locator: string;
  readonly headingId: string;
  readonly contentHash: string;
  readonly unitChars: number;
  readonly truncatedTo: number;
  readonly indexedBy: IndexedBy;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /**
   * ⚠ WHERE THE HEADING ACTUALLY IS NOW. `heading_id` (column B) holds the
   * anchor the index's reference lines still point at — the outstanding
   * repair. Blank here means the two agree and nothing is outstanding.
   *
   * B populated AND I populated means: the index points at B, the document is
   * at I, THEY DISAGREE. The row is self-explaining, which an earlier name for
   * this column ("superseded_anchor") was not — that reads as "the anchor that
   * got superseded", which is the DEAD one, and the dead one lives in B. The
   * name said the opposite of what the column holds.
   */
  readonly liveAnchor: string;
}

/**
 * ⚠ HASHES THE WHOLE UNIT BODY, whitespace-normalised, NOT the heading alone
 * and NOT the truncated prompt slice.
 *
 * The spec's §2 asks which failure is preferable and answers it: a
 * heading-only hash never fires when a body is rewritten, which is exactly the
 * August case that went unnoticed. A whole-body hash fires on a typo fix too —
 * over-triggering — and that is the failure worth having HERE precisely
 * because nothing is repaired automatically. The hash only ever produces a
 * line in a report, so a false positive costs a glance and a false negative
 * costs a chapter silently misdescribed.
 *
 * Whitespace is normalised so a reflow is not reported as a rewrite.
 */
export function contentHash(body: string): string {
  return createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

export function parsePlanStateRow(row: SheetRow): PlanSectionState | null {
  const locator = cell(row, PLAN_STATE_COLS.locator);
  if (locator === '') return null;
  const by = cell(row, PLAN_STATE_COLS.indexedBy).toLowerCase();
  return {
    locator,
    headingId: cell(row, PLAN_STATE_COLS.headingId),
    contentHash: cell(row, PLAN_STATE_COLS.contentHash),
    unitChars: Number(cell(row, PLAN_STATE_COLS.unitChars)) || 0,
    truncatedTo: Number(cell(row, PLAN_STATE_COLS.truncatedTo)) || 0,
    // ⚠ ANYTHING UNRECOGNISED IS TREATED AS `hand`, never as `routine`. The
    // permissive direction here would let the routine believe it owns
    // references a human wrote.
    // ⚠ THE PERMISSIVE DIRECTION IS STILL `hand`, NEVER `routine`. An
    // unrecognised value must not let the routine believe it owns references a
    // human wrote. `unindexed` is recognised explicitly; everything else is
    // treated as human work.
    indexedBy: by === 'routine' ? 'routine' : by === 'unindexed' ? 'unindexed' : 'hand',
    firstSeen: cell(row, PLAN_STATE_COLS.firstSeen),
    lastSeen: cell(row, PLAN_STATE_COLS.lastSeen),
    liveAnchor: cell(row, PLAN_STATE_COLS.liveAnchor),
  };
}

export function serializePlanStateRow(s: PlanSectionState): unknown[] {
  const cells = new Array<unknown>(PLAN_STATE_COLUMNS).fill('');
  cells[PLAN_STATE_COLS.locator] = s.locator;
  cells[PLAN_STATE_COLS.headingId] = s.headingId;
  cells[PLAN_STATE_COLS.contentHash] = s.contentHash;
  cells[PLAN_STATE_COLS.unitChars] = s.unitChars;
  cells[PLAN_STATE_COLS.truncatedTo] = s.truncatedTo;
  cells[PLAN_STATE_COLS.indexedBy] = s.indexedBy;
  cells[PLAN_STATE_COLS.firstSeen] = s.firstSeen;
  cells[PLAN_STATE_COLS.lastSeen] = s.lastSeen;
  cells[PLAN_STATE_COLS.liveAnchor] = s.liveAnchor;
  return cells;
}

export type DriftVerdict = 'unseen' | 'unchanged' | 'CHANGED';

/** Has this section moved since it was indexed? Reported, never acted on. */
export function driftOf(prior: PlanSectionState | undefined, hash: string): DriftVerdict {
  if (!prior) return 'unseen';
  return prior.contentHash === hash ? 'unchanged' : 'CHANGED';
}

// --- Reconciliation: four classes, on two keys ------------------------------

/**
 * ⚠ A LOCATOR IS NOT AN IDENTITY, AND MATCHING ON IT ALONE REPORTS FALSE DEATHS.
 *
 * The locator is derived from heading TEXT, so any edit to the heading mints a
 * new one. Measured 2026-09-08: locator-only matching called 18 sections GONE,
 * of which FOUR were alive — `OPERATIONAL BACKLOGS` was reported dead and
 * newborn in the same run, one section counted twice.
 *
 * `heading_id` is the stable key and the state tab has always stored it. But it
 * is not sufficient either, and the reason is the whole point of this module:
 * ⚠ A HEADING'S IDENTITY DIES WITH THE PARAGRAPH, NOT WITH ITS TEXT. Retype a
 * heading and Docs mints a fresh ID while every character stays put — so the
 * id changes and the locator does not. `INCIDENT 2` did exactly that on
 * 2026-09-07 (h.lagfoh7a5rp3 -> h.cmytyawr14t8) and every text-based check
 * passed it while its links pointed nowhere.
 *
 * So the two keys are reconciled TOGETHER, and which of them matches is itself
 * the finding:
 *
 *   both            -> ALIVE
 *   id only         -> RENAMED         (heading text edited; links still good)
 *   locator only    -> ANCHOR CHANGED  (paragraph retyped; EVERY LINK IS DEAD)
 *   neither         -> GONE
 */
export type SectionClass = 'ALIVE' | 'RENAMED' | 'ANCHOR_CHANGED' | 'GONE';

/** The live shape of one Plan section, reduced to what reconciliation needs. */
export interface LiveSection {
  readonly locator: string;
  readonly headingId: string;
  readonly contentHash: string;
  readonly unitChars: number;
  readonly truncatedTo: number;
}

export interface ReconciledSection {
  readonly cls: SectionClass;
  readonly prior: PlanSectionState;
  /** Null only for GONE. */
  readonly live: LiveSection | null;
  /** Content drift, for every class that still has live text. */
  readonly drift: DriftVerdict;
}

export interface ReconcileResult {
  readonly alive: readonly ReconciledSection[];
  readonly renamed: readonly ReconciledSection[];
  readonly anchorChanged: readonly ReconciledSection[];
  readonly gone: readonly ReconciledSection[];
  /** Live sections matching no state row on either key. */
  readonly fresh: readonly LiveSection[];
}

/**
 * ⚠ ID IS MATCHED FIRST AND CONSUMED, so one live section can satisfy at most
 * one state row. Matching by locator first would let a prefix match steal a
 * section from the row that owns it by id, and the loser would report GONE.
 */
export function reconcilePlanState(
  prior: readonly PlanSectionState[],
  live: readonly LiveSection[],
  locatorMatches: (a: string, b: string) => boolean,
): ReconcileResult {
  const byId = new Map<string, LiveSection>();
  for (const l of live) if (l.headingId !== '') byId.set(l.headingId, l);

  const claimed = new Set<LiveSection>();
  const alive: ReconciledSection[] = [];
  const renamed: ReconciledSection[] = [];
  const anchorChanged: ReconciledSection[] = [];
  const gone: ReconciledSection[] = [];

  // Pass 1 — the strong key.
  const unresolved: PlanSectionState[] = [];
  for (const p of prior) {
    const hit = p.headingId === '' ? undefined : byId.get(p.headingId);
    if (hit && !claimed.has(hit)) {
      claimed.add(hit);
      const rec: ReconciledSection = { cls: locatorMatches(hit.locator, p.locator) ? 'ALIVE' : 'RENAMED', prior: p, live: hit, drift: driftOf(p, hit.contentHash) };
      (rec.cls === 'ALIVE' ? alive : renamed).push(rec);
    } else unresolved.push(p);
  }

  // Pass 2 — the weak key, over what the strong key did not claim.
  for (const p of unresolved) {
    const hit = live.find((l) => !claimed.has(l) && locatorMatches(l.locator, p.locator));
    if (hit) {
      claimed.add(hit);
      anchorChanged.push({ cls: 'ANCHOR_CHANGED', prior: p, live: hit, drift: driftOf(p, hit.contentHash) });
    } else {
      gone.push({ cls: 'GONE', prior: p, live: null, drift: 'unseen' });
    }
  }

  return { alive, renamed, anchorChanged, gone, fresh: live.filter((l) => !claimed.has(l)) };
}

/**
 * The row to store for one reconciled section.
 *
 * ⚠ ON `ANCHOR_CHANGED` THE HASH MOVES AND `heading_id` DOES NOT, AND THAT
 * ASYMMETRY IS THE WHOLE DESIGN.
 *
 * `heading_id` records the anchor THE INDEX'S REFERENCE LINES ACTUALLY POINT
 * AT. When a paragraph is retyped, those lines keep pointing at the dead
 * anchor until someone re-anchors them — which nothing here can do, because
 * re-anchoring is a transform and insertLink cannot reach an existing
 * character. Writing the new anchor in immediately would make tomorrow's
 * report clean while 65 reference lines still point nowhere: A GREEN REPORT
 * OVER A REAL DEFECT, which is the exact shape this whole system exists to
 * catch. The report must stay truthful about THE INDEX, not about the
 * document.
 *
 * So the new anchor goes to `live_anchor` and B keeps the dead one, which is
 * the outstanding repair; the row keeps re-reporting until the references are
 * actually moved.
 *
 * The hash DOES move, because it answers a different question — "is the text
 * still what we indexed" — and freezing it would hide every later edit behind
 * one unresolved anchor.
 *
 * ⚠ A GONE ROW IS RETURNED UNCHANGED, `last_seen` INCLUDED. Bumping it would
 * assert the section was seen on a day it was already absent.
 */
export function nextStateFor(rec: ReconciledSection, today: string): PlanSectionState {
  // ⚠ `live === null` IS the GONE test, and is deliberately the ONLY one here.
  // An earlier version also checked `cls === 'GONE'`; mutation testing showed
  // no input could distinguish the two, because reconcilePlanState leaves
  // `live` null for GONE and non-null for every other class BY CONSTRUCTION.
  // A guard no test can kill is a guard nobody is maintaining, so there is one.
  if (rec.live === null) return rec.prior;
  const { prior, live } = rec;
  return {
    locator: rec.cls === 'ANCHOR_CHANGED' ? prior.locator : live.locator,
    headingId: rec.cls === 'ANCHOR_CHANGED' ? prior.headingId : live.headingId,
    contentHash: live.contentHash,
    unitChars: live.unitChars,
    truncatedTo: live.truncatedTo,
    indexedBy: prior.indexedBy,
    firstSeen: prior.firstSeen || today,
    lastSeen: today,
    // Where the heading is NOW. B keeps the dead anchor the index points at.
    liveAnchor: rec.cls === 'ANCHOR_CHANGED' ? live.headingId : prior.liveAnchor,
  };
}

/**
 * The provenance a row should carry after this run.
 *
 * ⚠ COUNTS WHAT HAPPENED, NOT WHAT WAS INTENDED. `wroteThisRun` must be built
 * from CONFIRMED reference-line writes, so the state write has to happen AFTER
 * the write loop. This is the same distinction as counting confirmed writes
 * rather than attempted ones, which this repo has now got wrong seven times.
 *
 * The transitions, and why each is safe:
 *
 *   any        + this run wrote lines        -> routine    (observed, not assumed)
 *   unindexed  + references exist otherwise  -> hand       (someone else wrote them)
 *   routine    + no references               -> unindexed  (corrects the lie)
 *   hand       + no references               -> hand       (⚠ NEVER DEMOTED — see below)
 *   otherwise                                -> unchanged
 *
 * ⚠ `hand` IS NEVER DEMOTED, AND THAT ASYMMETRY IS DELIBERATE. Demoting it
 * would open a path back up to `routine` on a later run, letting the routine
 * claim ownership of references a human wrote — the one thing provenance
 * exists to prevent. A hand-indexed section whose references were deleted is
 * still reported, because the QC rule derives "nothing points at this" from
 * THE INDEX rather than from this column.
 */
export function provenanceFor(args: {
  readonly prior: IndexedBy | null;
  readonly referencedInIndex: boolean;
  readonly wroteThisRun: boolean;
}): IndexedBy {
  if (args.wroteThisRun) return 'routine';
  if (args.prior === null) return args.referencedInIndex ? 'hand' : 'unindexed';
  if (args.prior === 'unindexed' && args.referencedInIndex) return 'hand';
  if (args.prior === 'routine' && !args.referencedInIndex) return 'unindexed';
  return args.prior;
}
