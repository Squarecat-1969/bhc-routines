/**
 * Zoom DISCOVERY — the scheduled sweep (Phase A).
 *
 * Replaces D-STEP 1/2/3 of routines/BHC_Zoom.md. Everything downstream —
 * STEP 0, PASS 1, PASS 2 — is untouched and still lives in that file.
 *
 * THE DEFECT THIS FIXES: D-STEP 3 wrote column G (topline_summary) blank by
 * design, because topline is a PASS 2 output and PASS 2 only runs AFTER a row
 * is triaged from NEW to PROCESS. So the human was asked to decide Process or
 * Pass using a column the pipeline had not filled yet, and the queue silted up
 * with identical-looking "Impromptu Zoom Meeting" rows. D-STEP 2 never
 * requested a summary either, so the data was not merely unwritten — it was
 * never fetched. Capture must supply what triage needs.
 *
 * THIS IS NOT ENRICHMENT. Every value written here is one the provider has
 * already computed and hands back in a response we are already receiving and
 * currently discard. PASS 2 still overwrites column G when it runs, and that
 * is correct: the DISCOVERY value has one job, make the row triageable, and a
 * deliberately short life.
 *
 * NO INTERNAL/EXTERNAL CLASSIFIER. An "Impromptu Zoom Meeting" in live data
 * turned out to be an external client call, so any "no invitees therefore
 * internal therefore auto-pass" rule would silently discard real client
 * conversations. There is no reliable capture-time signal — the only
 * authoritative attendee data is in the transcript, which is a large per-
 * meeting fetch we deliberately do not make. Every row reaches the human.
 */

import { cell, type SheetRow, type SheetsClient } from '../lib/sheets.js';
import { summaryMarkdown, type FathomClient, type FathomMeeting } from '../lib/fathom.js';

export const STAGING_RANGE = 'Zoom_Staging!A2:N';
export const STAGING_APPEND_RANGE = 'Zoom_Staging!A1';

/** Zoom_Staging columns, 0-based, per BHC_Zoom.md's own A–N schema. */
export const COL = {
  recordingId: 0, // A
  title: 1, // B
  meetingDate: 2, // C
  duration: 3, // D
  participants: 4, // E
  recordingUrl: 5, // F
  toplineSummary: 6, // G
  status: 7, // H
  runId: 13, // N
} as const;

/**
 * Statuses a row can hold BEFORE a human has triaged it. Backfill only touches
 * these — a PROCESS/WRITE/DONE row's blank topline is not DISCOVERY's business.
 *
 * Kept as a set rather than a `=== 'NEW'` test because the notes are explicit
 * that the live sheet should be checked for other pre-triage statuses rather
 * than trusting the lifecycle described in spec prose. The pass reports every
 * distinct status it observed so an operator can confirm this list against
 * reality without reading the sheet by hand.
 */
export const PRE_TRIAGE_STATUSES: ReadonlySet<string> = new Set(['NEW']);

export const TOPLINE_MAX_CHARS = 200;
/** Heavy-request budget degrades to 5/60s under load; never loop until done. */
export const BACKFILL_CAP = 10;

// ── Pure parsers ──────────────────────────────────────────────────────────
// These are the whole reason the summary is parseable at all, and they are
// unit-tested against real fixtures of both escaping variants.

/**
 * Undo the list endpoint's escaping so ONE set of parsers handles both call
 * shapes. `/meetings` returns escaped hashes (`\#\#`); the per-recording
 * endpoint returns clean markdown. Normalising first means the heading matcher
 * and the Next-Steps regex each exist once instead of twice — a second copy is
 * how the queue and new captures would drift apart.
 */
export function normalizeMarkdown(md: string): string {
  return md.replace(/\\([#*_[\]()\-.])/g, '$1').replace(/\r\n?/g, '\n');
}

/** `[label](url)` → `label`; `<url>` → `url`. Keep the label, discard the URL. */
export function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<(https?:[^>]+)>/g, '$1');
}

function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, '').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2');
}

/**
 * True for a line that opens a new section, so purpose extraction knows where
 * to stop. Covers ATX headings and a bold-only line, which both appear across
 * the two summary shapes. Assumes already-normalized text.
 */
export function isHeadingLine(line: string): boolean {
  if (/^\s{0,3}#{1,6}\s+\S/.test(line)) return true;
  return /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line);
}

/** The heading's own text, stripped of #'s, links and emphasis. */
function headingText(line: string): string {
  const withoutHashes = line.replace(/^\s{0,3}#{1,6}\s*/, '');
  return stripEmphasis(stripMarkdownLinks(withoutHashes)).replace(/:\s*$/, '').trim();
}

/**
 * Trim to `max` characters on a word boundary. Never cuts mid-word, and never
 * returns more than `max`. A single word longer than `max` is hard-cut — the
 * alternative is returning nothing, which loses more than it protects.
 */
export function trimToWordBoundary(text: string, max: number = TOPLINE_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace <= 0) return slice.trimEnd();
  return slice.slice(0, lastSpace).replace(/[\s,;:.\-–—]+$/, '').trimEnd();
}

/**
 * The Meeting Purpose line: text under that heading, up to the next heading,
 * as one line, link syntax stripped, capped at 200 chars on a word boundary.
 *
 * Returns null when the section is absent or empty. NEVER invents a topline —
 * a blank column G is recoverable by a later sweep, a fabricated one is not.
 */
export function extractMeetingPurpose(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const lines = normalizeMarkdown(markdown).split('\n');

  let start = -1;
  let inlineRemainder = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isHeadingLine(line)) continue;
    const text = headingText(line);
    if (!/^meeting\s+purpose\b/i.test(text)) continue;
    start = i;
    // `## Meeting Purpose: we discussed X` — the body can ride the heading.
    const after = text.replace(/^meeting\s+purpose\b/i, '').replace(/^[:\-–—\s]+/, '');
    inlineRemainder = after;
    break;
  }
  if (start === -1) return null;

  const body: string[] = [];
  if (inlineRemainder.trim() !== '') body.push(inlineRemainder);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHeadingLine(line)) break;
    body.push(line);
  }

  const oneLine = stripEmphasis(stripMarkdownLinks(body.join(' ')))
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine === '') return null;
  return trimToWordBoundary(oneLine, TOPLINE_MAX_CHARS);
}

/**
 * The literal name Fathom uses for the section. Matched case-insensitively
 * against heading text, never against raw markdown.
 */
const NEXT_STEPS_HEADING = /^next\s+steps\b/i;

/**
 * The slice of a summary under a given heading, up to the next heading or the
 * end of the document. Returns null when the section is absent — the caller
 * must treat that as "no owners", never as "scan everything".
 *
 * Reuses the same isHeadingLine/headingText helpers Meeting Purpose extraction
 * uses, so the two agree on what a heading is.
 */
export function sliceSection(markdown: string, heading: RegExp): string | null {
  const lines = normalizeMarkdown(markdown).split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isHeadingLine(lines[i]!)) continue;
    if (heading.test(headingText(lines[i]!))) { start = i; break; }
  }
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeadingLine(lines[i]!)) break;
    body.push(lines[i]!);
  }
  return body.join('\n');
}

/**
 * Next-Steps owners: a bolded name with a colon, at a bullet start, INSIDE the
 * Next Steps section.
 *
 * TWO THINGS MAKE THIS CORRECT, AND EITHER ALONE IS WRONG.
 *
 * 1. THE COLON SITS INSIDE THE BOLD. Real Fathom output is
 *    `- [**Andrew:** Present the two options...](url)` — the colon is part of
 *    the bolded run, and the whole bullet is the link label. The spec's regex
 *    in §5.2 expects `**Andrew**:` with the colon outside, and its name class
 *    cannot match ':', so it never reaches the closing `**`. That pattern
 *    scores ZERO matches on every real summary. Both placements are accepted
 *    here; the capture group is unchanged.
 *
 * 2. THE SEARCH IS SCOPED TO THE SECTION. Fixing only the regex makes things
 *    strictly WORSE, because the same bulleted-bold-prefix shape is used
 *    throughout Key Takeaways and Topics for non-people labels — Method,
 *    Black, White, Result, Feasibility, Rationale, Outcome, Workaround,
 *    Description, Benefit, Constraint. Every one of those matches
 *    `[A-Z][\w]+` before a colon, and unscoped they would land in a
 *    participants field: precisely the over-matching §5.3 rejects. So the
 *    regex only ever runs against the Next Steps slice, and a summary with no
 *    Next Steps section yields [] rather than falling back to the whole text.
 *
 * The §5.4 limit still stands: only people assigned an action item are caught.
 * Someone who attended and committed to nothing stays absent, and the field
 * stays blank — never wrong, just silent.
 */
const NEXT_STEPS_OWNER = /^\s*-\s*\[?\*\*([A-Z][\w'’\-]+)(?::\*\*|\*\*(?:\]\([^)]*\))?\s*:)/;

export function extractNextStepsOwners(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const section = sliceSection(markdown, NEXT_STEPS_HEADING);
  if (section === null) return []; // no section, no owners. Never scan the whole summary.

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of section.split('\n')) {
    const m = NEXT_STEPS_OWNER.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * The account owner, rendered as "you" in a derived participant list.
 *
 * Bobby is on nearly every call, so his name as a participant HINT carries no
 * information — it is the one name guaranteed to be there. Dropping him
 * entirely would lose something real though: whether the call was a 1:1 or a
 * group. "you" keeps the shape of the room while spending no attention.
 *
 * TIER 2 ONLY. Tier 1 calendar_invitees are verified attendee data and are
 * written verbatim — never rewritten, never relabelled.
 */
export const SELF_NAMES: ReadonlySet<string> = new Set(['bobby']);
export const SELF_LABEL = 'you';

function asDisplayName(name: string): string {
  return SELF_NAMES.has(name.toLowerCase()) ? SELF_LABEL : name;
}

/** The suffix is load-bearing — see participantsFor. */
export const DERIVED_SUFFIX = '(from summary)';

/**
 * Column E's fallback ladder. A FALLBACK, NOT A REPLACEMENT: real invitee data
 * always wins and is written without a suffix.
 *
 *   Tier 1  calendar_invitees present  → comma-join, no extra call
 *   Tier 2  empty                      → Next-Steps owners + `(from summary)`
 *   Tier 3  neither                    → blank. Never guess.
 *
 * THE `(from summary)` SUFFIX IS LOAD-BEARING. It marks a derived list so
 * nothing downstream mistakes it for verified attendees — PASS 2 resolves real
 * participants from the transcript; this is a triage hint only.
 *
 * `calendar_invitees` is empty for every impromptu meeting and that is causal,
 * not incidental: a meeting is titled "Impromptu" precisely because no calendar
 * invite exists, and the invitee list derives from that same invite.
 */
export function participantsFor(meeting: FathomMeeting, markdown: string | null): string {
  const invitees = meeting.calendar_invitees ?? [];
  const named = invitees
    .map((i) => (i.name ?? '').trim() || (i.email ?? '').trim())
    .filter((v) => v !== '');
  if (named.length > 0) return named.join(', ');

  const owners = extractNextStepsOwners(markdown).map(asDisplayName);
  if (owners.length > 0) return `${owners.join(', ')} ${DERIVED_SUFFIX}`;

  return '';
}

/** `recording_start_time` → `YYYY-MM-DD`, or blank when unparseable. */
export function meetingDate(meeting: FathomMeeting): string {
  const raw = meeting.recording_start_time ?? meeting.scheduled_start_time ?? meeting.created_at;
  if (!raw) return '';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

/** Duration as a whole-minute string, or blank. Never fabricated. */
export function meetingDuration(meeting: FathomMeeting): string {
  const start = meeting.recording_start_time ?? meeting.scheduled_start_time;
  const end = meeting.recording_end_time ?? meeting.scheduled_end_time;
  if (!start || !end) return '';
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return '';
  return `${Math.round((b - a) / 60_000)} min`;
}

export function meetingTitle(meeting: FathomMeeting): string {
  return (meeting.title ?? meeting.meeting_title ?? '').trim();
}

export function meetingUrl(meeting: FathomMeeting): string {
  return (meeting.url ?? meeting.share_url ?? '').trim();
}

export function recordingIdOf(meeting: FathomMeeting): string {
  const id = meeting.recording_id;
  if (id === undefined || id === null) return '';
  return String(id).trim();
}

/**
 * Dedupe key for a URL.
 *
 * TWO URL FORMATS EXIST IN LIVE DATA — `/share/<token>` and `/calls/<id>` —
 * for the same recording, so comparing whole URLs matches nothing and a naive
 * join fails on every meeting. recording_id is the primary key; this exists
 * only as a secondary net for legacy rows whose column A is blank. It
 * deliberately keys on the trailing token alone, which is the one part the two
 * formats share when they refer to the same call.
 */
export function urlKey(url: string): string {
  const trimmed = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  const last = trimmed.split('/').filter((s) => s !== '').at(-1) ?? '';
  return last.toLowerCase();
}

/** One Zoom_Staging row, columns A–N. No columns added — the schema is fixed. */
export function toStagingRow(args: {
  recordingId: string;
  title: string;
  date: string;
  duration: string;
  participants: string;
  url: string;
  topline: string;
  runId: string;
}): unknown[] {
  return [
    args.recordingId, // A
    args.title, // B
    args.date, // C
    args.duration, // D
    args.participants, // E
    args.url, // F
    args.topline, // G
    'NEW', // H
    '', '', '', '', '', // I-M
    args.runId, // N
  ];
}

// ── The pass ──────────────────────────────────────────────────────────────

export interface ZoomDiscoveryReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lookbackHours: number;
  readonly existingRows: number;
  /** Distinct column-H values seen, so PRE_TRIAGE_STATUSES can be verified. */
  readonly observedStatuses: Readonly<Record<string, number>>;
  readonly fetched: number;
  readonly skippedOlderThanCutoff: number;
  readonly skippedDuplicate: number;
  readonly appended: readonly string[];
  readonly appendedWithoutTopline: readonly string[];
  readonly backfillCandidates: number;
  /** Rows a write was computed and issued for. Intent. */
  readonly backfillPlanned: number;
  /**
   * Rows whose write was CONFIRMED by reading the cell back. Outcome.
   * Deliberately distinct from `backfillPlanned`: a report that cannot tell
   * those apart is how a run of 10 withheld writes read as 10 successes.
   * Always empty on a dry run, because a dry run writes nothing.
   */
  readonly backfilled: readonly { readonly recordingId: string; readonly row: number; readonly what: string }[];
  readonly wouldWrite: readonly string[];
  readonly warnings: readonly string[];
}

export interface ZoomDiscoveryDeps {
  readonly sheets: SheetsClient;
  readonly fathom: FathomClient;
  readonly logger: { info(m: string): void; warn(m: string): void };
  readonly dryRun: boolean;
  readonly runId: string;
  readonly lookbackHours?: number;
  readonly limit?: number;
  readonly now?: Date;
}

export async function runZoomDiscovery(deps: ZoomDiscoveryDeps): Promise<ZoomDiscoveryReport> {
  const { sheets, fathom, logger, dryRun, runId } = deps;
  const now = deps.now ?? new Date();
  const lookbackHours = deps.lookbackHours ?? 24;
  const startedAt = now.toISOString();
  const warnings: string[] = [];
  const wouldWrite: string[] = [];

  logger.info(`BHC Zoom DISCOVERY - ${runId}`);
  logger.info(`  mode : ${dryRun ? 'DRY RUN (no writes issued anywhere)' : 'LIVE (appends Zoom_Staging)'}`);

  // ── 1. Known rows, for dedupe and backfill scope ─────────────────────────
  const rows = await sheets.read(STAGING_RANGE);
  const knownIds = new Set<string>();
  const knownUrlKeys = new Set<string>();
  const observedStatuses: Record<string, number> = {};
  for (const r of rows) {
    const id = cell(r, COL.recordingId);
    if (id !== '') knownIds.add(id);
    const k = urlKey(cell(r, COL.recordingUrl));
    if (k !== '') knownUrlKeys.add(k);
    const status = cell(r, COL.status) || '(blank)';
    observedStatuses[status] = (observedStatuses[status] ?? 0) + 1;
  }
  logger.info(`  ${rows.length} existing row(s) · statuses: ${JSON.stringify(observedStatuses)}`);
  const unexpected = Object.keys(observedStatuses).filter(
    (s) => s !== '(blank)' && !PRE_TRIAGE_STATUSES.has(s) && !['PROCESS', 'PASS', 'WRITE', 'DONE', 'REVIEW', 'ERROR'].includes(s),
  );
  if (unexpected.length > 0) {
    warnings.push(`Unrecognised Zoom_Staging status(es): ${unexpected.join(', ')} - confirm whether any is pre-triage before trusting backfill scope`);
  }

  // ── 2. Discover ──────────────────────────────────────────────────────────
  // include_summary makes this a HEAVY request, and it is the point: column G
  // comes from this one call rather than one extra call per meeting.
  const cutoffMs = now.getTime() - lookbackHours * 3_600_000;
  const meetings = await fathom.listMeetings({
    createdAfter: new Date(cutoffMs).toISOString(),
    includeSummary: true,
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
  });
  logger.info(`  fetched ${meetings.length} meeting(s) in the last ${lookbackHours}h`);

  const appended: string[] = [];
  const appendedWithoutTopline: string[] = [];
  const newRows: unknown[][] = [];
  let skippedOlderThanCutoff = 0;
  let skippedDuplicate = 0;

  for (const m of meetings) {
    const id = recordingIdOf(m);
    const url = meetingUrl(m);
    const date = meetingDate(m);

    // The API filters server-side; re-checking locally keeps a lookback change
    // or a loose server filter from quietly widening what gets appended.
    const startRaw = m.recording_start_time ?? m.scheduled_start_time ?? m.created_at;
    const startMs = startRaw ? Date.parse(startRaw) : Number.NaN;
    if (!Number.isNaN(startMs) && startMs < cutoffMs) {
      skippedOlderThanCutoff += 1;
      continue;
    }

    // recording_id is primary. urlKey is the secondary net for legacy rows
    // with a blank column A — never the primary test, because the two live URL
    // formats do not compare equal for the same recording.
    if (id !== '' && knownIds.has(id)) { skippedDuplicate += 1; continue; }
    const k = urlKey(url);
    if (id === '' && k !== '' && knownUrlKeys.has(k)) { skippedDuplicate += 1; continue; }
    if (id === '' && k === '') {
      warnings.push(`Meeting "${meetingTitle(m)}" has neither recording_id nor url - skipped, cannot dedupe it on a later run`);
      continue;
    }

    const md = summaryMarkdown(m.default_summary ?? m.summary);
    const topline = extractMeetingPurpose(md) ?? '';
    if (topline === '') {
      appendedWithoutTopline.push(id || k);
      logger.info(`  ${id || k}: no Meeting Purpose in summary - column G left blank, a later sweep will backfill it`);
    }

    newRows.push(
      toStagingRow({
        recordingId: id,
        title: meetingTitle(m),
        date,
        duration: meetingDuration(m),
        participants: participantsFor(m, md),
        url,
        topline,
        runId,
      }),
    );
    appended.push(id || k);
    if (id !== '') knownIds.add(id);
    if (k !== '') knownUrlKeys.add(k);
  }

  if (newRows.length > 0) {
    if (dryRun) {
      for (const r of newRows) wouldWrite.push(`APPEND ${STAGING_APPEND_RANGE} ${JSON.stringify(r)}`);
    } else {
      const res = await sheets.append(STAGING_APPEND_RANGE, newRows);
      if (res.updatedRows === 0) {
        warnings.push(`Zoom_Staging append reported 0 rows written - ${newRows.length} meeting(s) may not have landed`);
      }
    }
  }

  // ── 3. Backfill blank cells ──────────────────────────────────────────────
  // SAME extraction functions as above, deliberately — a second implementation
  // drifts, and then the queue and new captures disagree.
  //
  // FILL BLANKS ONLY, PER COLUMN. A non-empty E or G may be PASS 2's and is
  // strictly better than anything derivable here, so neither is ever
  // overwritten. The two are decided INDEPENDENTLY.
  //
  // WHY INDEPENDENTLY, AND NOT "G IS BLANK" AS BEFORE: gating the whole
  // candidate on a blank G conflated "needs a topline" with "needs
  // backfilling". Rows written by an earlier sweep got their G filled while
  // their E stayed blank — the Next-Steps regex matched nothing on any real
  // summary at the time — and were then permanently ineligible, so E would
  // never be revisited on them. Four such rows were sitting in the live sheet
  // (166787602, 168021862, 170154946, 170114152): status NEW, G filled, E
  // blank, and the fixed extractor produces real owners for them.
  //
  // ACCEPTED COST, deliberately not optimised away: a Tier 3 row — no
  // invitees and no Next-Steps owners — has a legitimately blank E and will be
  // re-fetched on every sweep until it is triaged. That is bounded by
  // BACKFILL_CAP and by NEW rows draining as they are triaged. A "tried and
  // failed" marker column would fix it and is the wrong trade: the schema is
  // fixed, and one wasted heavy request per sweep is cheaper than a new column
  // and the state it would carry.
  const candidates: {
    row: number;
    recordingId: string;
    needsTopline: boolean;
    needsParticipants: boolean;
  }[] = [];
  rows.forEach((r, i) => {
    if (!PRE_TRIAGE_STATUSES.has(cell(r, COL.status))) return;
    const id = cell(r, COL.recordingId);
    if (id === '') return; // nothing to fetch by
    const needsTopline = cell(r, COL.toplineSummary) === '';
    const needsParticipants = cell(r, COL.participants) === '';
    if (!needsTopline && !needsParticipants) return; // nothing blank, nothing to do
    candidates.push({ row: i + 2, recordingId: id, needsTopline, needsParticipants });
  });

  // Rows needing BOTH cells first, so a capped run does the most good per
  // heavy request. Stable within each group, so row order is otherwise kept.
  candidates.sort((a, b) => {
    const score = (c: typeof a) => (c.needsTopline ? 1 : 0) + (c.needsParticipants ? 1 : 0);
    return score(b) - score(a);
  });

  // PLANNED, not done. Nothing enters `backfilled` until a read-back confirms
  // it landed — see the verification block below. `expectG`/`expectE` are null
  // for a cell this row did not need, so verification only ever checks what
  // was actually written.
  const planned: {
    recordingId: string;
    row: number;
    what: string;
    expectG: string | null;
    expectE: string | null;
  }[] = [];
  const batch: { range: string; values: readonly SheetRow[] }[] = [];

  for (const c of candidates.slice(0, BACKFILL_CAP)) {
    let md: string | null = null;
    try {
      md = await fathom.getSummary(c.recordingId);
    } catch (e) {
      warnings.push(`Backfill summary fetch failed for ${c.recordingId} (row ${c.row}): ${String(e)}`);
      continue;
    }

    const what: string[] = [];
    let expectG: string | null = null;
    let expectE: string | null = null;

    // G only when G is blank. A missing purpose section leaves it blank for a
    // later sweep rather than blocking this row's E write.
    if (c.needsTopline) {
      const topline = extractMeetingPurpose(md);
      if (topline) {
        expectG = topline;
        batch.push({ range: `Zoom_Staging!G${c.row}`, values: [[topline]] });
        what.push('G');
      }
    }

    // E only when E is blank. Same ladder and same self-labelling as the
    // capture path — one implementation, not two.
    if (c.needsParticipants) {
      const owners = extractNextStepsOwners(md).map((n) => (SELF_NAMES.has(n.toLowerCase()) ? SELF_LABEL : n));
      if (owners.length > 0) {
        expectE = `${owners.join(', ')} ${DERIVED_SUFFIX}`;
        batch.push({ range: `Zoom_Staging!E${c.row}`, values: [[expectE]] });
        what.push('E');
      }
    }

    // Nothing extractable yet — still processing, or a Tier 3 row. A later
    // sweep retries; nothing is recorded as planned.
    if (what.length === 0) continue;
    planned.push({ recordingId: c.recordingId, row: c.row, what: what.join('+'), expectG, expectE });
  }

  const backfilled: { recordingId: string; row: number; what: string }[] = [];

  if (batch.length > 0) {
    if (dryRun) {
      for (const b of batch) wouldWrite.push(`SHEETS ${b.range} = ${JSON.stringify(b.values[0]?.[0] ?? '')}`);
    } else {
      // One request, not one per cell — Sheets quota is counted per request.
      const res = await sheets.batchUpdate(batch);

      // OUTCOME, NOT INTENT. This pass previously counted a row as backfilled
      // the moment it COMPUTED the value, before any write was issued, and
      // then discarded batchUpdate's response entirely. A live run duly
      // reported "backfilled 10" while all ten column-G cells stayed blank —
      // the same silent-success shape as Part D's month of withheld CRM
      // writes. The response is checked, and then the cells are READ BACK,
      // because the response alone only says what Google claims it did.
      if (!res.fieldsPresent) {
        warnings.push(
          `Zoom_Staging batchUpdate response carried no totalUpdatedCells - the write is UNVERIFIABLE from the response alone; relying entirely on the read-back below`,
        );
      } else if (res.totalUpdatedCells === 0) {
        warnings.push(
          `⚠ Zoom_Staging batchUpdate reported 0 of ${batch.length} cell(s) written - Google declined the write`,
        );
      }

      // The authoritative check. One extra read for the whole tab, not one per
      // row, so this costs a single request regardless of batch size.
      let after: SheetRow[] = [];
      try {
        after = await sheets.read(STAGING_RANGE);
      } catch (e) {
        warnings.push(`⚠ Backfill read-back FAILED (${String(e)}) - ${planned.length} row(s) are unconfirmed and are NOT reported as backfilled`);
        after = [];
      }

      const mismatched: string[] = [];
      for (const p of planned) {
        const row = after[p.row - 2];
        if (row === undefined) { mismatched.push(`row ${p.row} (${p.recordingId}): not readable after write`); continue; }
        if (p.expectG !== null) {
          const gotG = cell(row, COL.toplineSummary);
          if (gotG !== p.expectG) {
            mismatched.push(`row ${p.row} (${p.recordingId}): G is ${gotG === '' ? 'STILL BLANK' : JSON.stringify(gotG.slice(0, 40))}, expected ${JSON.stringify(p.expectG.slice(0, 40))}`);
            continue;
          }
        }
        if (p.expectE !== null) {
          const gotE = cell(row, COL.participants);
          if (gotE !== p.expectE) {
            mismatched.push(`row ${p.row} (${p.recordingId}): E is ${gotE === '' ? 'STILL BLANK' : JSON.stringify(gotE)}, expected ${JSON.stringify(p.expectE)}`);
            continue;
          }
        }
        backfilled.push({ recordingId: p.recordingId, row: p.row, what: p.what });
      }

      if (mismatched.length > 0) {
        warnings.push(
          `⚠ BACKFILL WRITE NOT CONFIRMED for ${mismatched.length} of ${planned.length} row(s) - read-back disagrees with what was written:\n  ${mismatched.join('\n  ')}`,
        );
      }
    }
  }

  if (dryRun) logger.info(`DRY RUN - ${wouldWrite.length} write(s) computed, 0 issued`);
  for (const w of warnings) logger.warn(w);

  return {
    runId, dryRun, startedAt, finishedAt: new Date().toISOString(),
    lookbackHours,
    existingRows: rows.length,
    observedStatuses,
    fetched: meetings.length,
    skippedOlderThanCutoff,
    skippedDuplicate,
    appended,
    appendedWithoutTopline,
    backfillCandidates: candidates.length,
    backfillPlanned: planned.length,
    backfilled,
    wouldWrite,
    warnings,
  };
}

/**
 * Slack text, or null when nothing was written.
 *
 * A sweep announcing "nothing found" 48 times a day is worse than silence, so
 * a no-op run returns null and the caller posts nothing at all.
 */
export function buildSlackMessage(report: ZoomDiscoveryReport): string | null {
  const unconfirmedWrites = !report.dryRun && report.backfillPlanned > report.backfilled.length;
  if (report.appended.length === 0 && report.backfilled.length === 0 && !unconfirmedWrites) return null;

  const lines = [`🎥 Zoom DISCOVERY - ${report.runId}`];
  if (report.appended.length > 0) {
    lines.push(`${report.appended.length} new meeting(s) staged as NEW`);
    if (report.appendedWithoutTopline.length > 0) {
      lines.push(`  -> ${report.appendedWithoutTopline.length} without a topline yet - a later sweep will fill it`);
    }
  }
  if (report.backfilled.length > 0) {
    const pending = report.backfillCandidates - report.backfilled.length;
    lines.push(`${report.backfilled.length} existing row(s) backfilled (confirmed by read-back)${pending > 0 ? ` · ${pending} still pending, capped at ${BACKFILL_CAP}/run` : ''}`);
  }
  // The silent-failure case, said out loud. A run that computed writes and
  // confirmed none must never render as a quiet success.
  const unconfirmed = report.backfillPlanned - report.backfilled.length;
  if (!report.dryRun && unconfirmed > 0) {
    lines.push(`⚠ ${unconfirmed} backfill write(s) NOT confirmed by read-back - column G may still be blank`);
  }
  if (report.warnings.length > 0) lines.push(`⚠ ${report.warnings.length} warning(s) - see the run artifact`);
  lines.push('Triage: aida.hougham.us (Meetings)');
  return lines.join('\n');
}
