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
import { summaryMarkdown, TRANSCRIPT_MAX_BYTES, type FathomClient, type FathomMeeting } from '../lib/fathom.js';

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

/**
 * Matches on the WHOLE name or its first token, because the two sources label
 * him differently: Next Steps says "Bobby", a transcript speaker label says
 * "Bobby Hougham". Matching only the whole string would let the self mapping
 * silently stop working the moment Tier 2 became the primary source.
 */
export function isSelf(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (SELF_NAMES.has(lower)) return true;
  const first = lower.split(/\s+/)[0] ?? '';
  return SELF_NAMES.has(first);
}

function asDisplayName(name: string): string {
  return isSelf(name) ? SELF_LABEL : name;
}

/**
 * A derived list naming ONLY the account owner is worse than no list at all.
 *
 * Aida promotes participants into the headline when the title is generic, so
 * `you (from summary)` renders as "Meeting with you" — a meeting with
 * yourself, less informative than the "Impromptu Zoom Meeting" it replaced.
 * Writing blank keeps the honest generic title.
 *
 * DERIVED LISTS ONLY. Tier 1 invitee data is verified and always written
 * verbatim, even if Bobby is the only invitee.
 */
export function isSelfOnly(displayNames: readonly string[]): boolean {
  return displayNames.length > 0 && displayNames.every((n) => n === SELF_LABEL);
}

/**
 * Speaker labels from a transcript, in order of first appearance.
 *
 * WHY THIS OUTRANKS NEXT-STEPS OWNERS: Next Steps answers "who owes
 * something", not "who was on the call". Measured on two real recordings, the
 * transcript roster is a superset — never worse, sometimes much better. On
 * 174393868 Next Steps yielded only Chuck, while the transcript showed Chuck
 * Granade, Sevrin Daniels and Bobby Hougham; Sevrin was present for 33 minutes
 * and simply was not assigned an action item.
 *
 * PARTIAL NAMES ARE ACCEPTABLE AND ARE NOT EXPANDED. Fathom labels speakers
 * from the platform display name, so an ad-hoc external guest often appears as
 * a bare first name ("Andrew"). A first name plus a topline is enough to
 * triage, and any attempt to expand, match or enrich it would be exactly the
 * machine judgement on insufficient data that §4.2 rejects.
 */
const TRANSCRIPT_SPEAKER = /^\[\d{1,2}:\d{2}(?::\d{2})?\]\([^)]*\)\s*([^:]+):/;

/** Last-resort scan for a truncated JSON body, which cannot be parsed. */
const DISPLAY_NAME_SCAN = /"display_name"\s*:\s*"([^"]+)"/g;

/**
 * THREE SHAPES, BECAUSE THE SOURCES GENUINELY DIFFER — verified against a live
 * response, not assumed:
 *
 *   1. The REST endpoint `/recordings/:id/transcript` returns STRUCTURED JSON:
 *      `{"transcript":[{"speaker":{"display_name":"Andrew",...},"text":...,
 *      "timestamp":...}]}`. This is what the scheduled sweep actually receives
 *      — 184 segments on the ad-hoc call measured.
 *   2. The MCP tool `get_meeting_transcript` renders the same data as lines of
 *      `[MM:SS](url) Name: text`.
 *   3. A TRUNCATED body is valid as neither, so display names are scanned out
 *      directly.
 *
 * Handling only shape 2 is how this feature would have shipped extracting
 * nothing: the line regex scores zero matches against the REST payload, the
 * ladder silently falls through to Tier 3, and the tests still pass because
 * their fixture is the MCP rendering. That is the third time in this file a
 * fixture from one source has disagreed with the shape actually received.
 */
function speakerNamesFrom(raw: string): string[] {
  const out: string[] = [];

  // Shape 1: structured JSON.
  try {
    const parsed: unknown = JSON.parse(raw);
    const segments = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown> | null)?.['transcript'] ?? null);
    if (Array.isArray(segments)) {
      for (const seg of segments) {
        if (!seg || typeof seg !== 'object') continue;
        const s = seg as Record<string, unknown>;
        const speaker = s['speaker'];
        const name =
          typeof speaker === 'string'
            ? speaker
            : speaker && typeof speaker === 'object'
              ? ((speaker as Record<string, unknown>)['display_name'] ?? (speaker as Record<string, unknown>)['name'])
              : s['speaker_name'];
        if (typeof name === 'string' && name.trim() !== '') out.push(name.trim());
      }
      return out;
    }
  } catch {
    // Not JSON, or truncated mid-array — fall through.
  }

  // Shape 2: the MCP line rendering.
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const m = TRANSCRIPT_SPEAKER.exec(line);
    if (m && m[1]!.trim() !== '') out.push(m[1]!.trim());
  }
  if (out.length > 0) return out;

  // Shape 3: truncated JSON — scan for display names directly.
  DISPLAY_NAME_SCAN.lastIndex = 0;
  for (let m = DISPLAY_NAME_SCAN.exec(raw); m !== null; m = DISPLAY_NAME_SCAN.exec(raw)) {
    if (m[1]!.trim() !== '') out.push(m[1]!.trim());
  }
  return out;
}

/**
 * A STRUCTURAL sketch of a response body, for diagnosing shape drift.
 *
 * ⚠ MUST NEVER LEAK TRANSCRIPT CONTENT. Two passes, because the two shapes
 * hide content differently:
 *   - JSON: every string that is NOT a key becomes "…", so field names and
 *     punctuation survive and values do not. That is the diagnostic part.
 *   - Anything else: every run of letters becomes "x", leaving only
 *     punctuation and digits. A markdown line renders as
 *     `[00:01](https://x.x/x) x: x x`.
 */
export function describeBodyShape(raw: string, max = 100): string {
  const head = raw.slice(0, 2_000);
  // Structural bracket ALONE is not enough: a line-formatted transcript opens
  // with `[00:01](...)`, and treating that as JSON left every word intact —
  // a content leak, caught by its own test. A quoted KEY must also be present.
  const looksJson = /^\s*[[{]/.test(head) && /"[A-Za-z_][\w-]*"\s*:/.test(head);

  if (looksJson) {
    // Quoted run followed by ':' is a key; anything else quoted is a value.
    const redacted = head.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (m, isKey: string | undefined) =>
      isKey ? m : '"…"',
    );
    return redacted.slice(0, max);
  }
  return head.replace(/[A-Za-z]+/g, 'x').slice(0, max);
}

/**
 * A non-empty body that yields no speakers is REPORTED, never swallowed.
 *
 * Shape drift between the REST endpoint and the MCP tool has now caused three
 * silent failures in this file. The fixture is always real; it is just
 * captured from a different client than the pass calls, so the tests pass, the
 * extractor returns [], and nothing complains. A silent [] is also
 * indistinguishable from a genuinely speakerless recording. This makes the
 * first affected run say so out loud instead of never.
 */
export function transcriptShapeWarning(recordingId: string, raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') return null; // no transcript yet is not drift
  if (extractTranscriptSpeakers(raw).length > 0) return null;
  return (
    `⚠ Transcript for ${recordingId} yielded ZERO speakers from a ${Buffer.byteLength(raw)}-byte body - ` +
    `the response shape may have changed. Structure only: ${describeBodyShape(raw)}`
  );
}

export function extractTranscriptSpeakers(transcript: string | null | undefined): string[] {
  if (!transcript) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of speakerNamesFrom(transcript)) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Provenance suffixes. LOAD-BEARING, and deliberately DIFFERENT per tier so
 * downstream can tell a transcript roster from an action-item roster — they
 * answer different questions and have different reliability. Neither may ever
 * be mistaken for verified attendee data; PASS 2 resolves real participants
 * from the transcript when it runs, and these are triage hints only.
 */
export const TRANSCRIPT_SUFFIX = '(from transcript)';
export const DERIVED_SUFFIX = '(from summary)';

/** Which rung of the ladder produced a value, for reporting. */
export type ParticipantTier = 1 | 2 | 3 | 4;

export interface ParticipantResult {
  readonly value: string;
  readonly tier: ParticipantTier;
  /** Set when a derived list was suppressed for naming only the account owner. */
  readonly selfOnlySuppressed?: boolean;
}

/**
 * Column E's fallback ladder. A FALLBACK, NOT A REPLACEMENT: real invitee data
 * always wins and is written verbatim.
 *
 *   Tier 1  calendar_invitees present   → comma-join, no suffix, no extra call
 *   Tier 2  invitees empty              → transcript speakers + `(from transcript)`
 *   Tier 3  transcript empty/unparsable → Next-Steps owners + `(from summary)`
 *   Tier 4  neither                     → blank. Never guess.
 *
 * Tier 2 outranks Tier 3 because a transcript roster answers "who was on the
 * call" while Next-Steps owners answer "who owes something" — the roster is a
 * superset in every case measured. Tier 3 is kept, not deleted: a meeting whose
 * transcript has not finished processing still gets a usable hint.
 *
 * PURE. The caller fetches; this decides. Keeping the I/O outside means the
 * whole ladder is unit-testable without credentials, which is how the two
 * previous parser defects here were caught.
 *
 * `calendar_invitees` is empty for every impromptu meeting and that is causal,
 * not incidental: a meeting is titled "Impromptu" precisely because no calendar
 * invite exists, and the invitee list derives from that same invite.
 */
export function participantsFor(
  meeting: FathomMeeting,
  sources: { transcript?: string | null; summary?: string | null },
): ParticipantResult {
  const invitees = meeting.calendar_invitees ?? [];
  const named = invitees
    .map((i) => (i.name ?? '').trim() || (i.email ?? '').trim())
    .filter((v) => v !== '');
  // Tier 1 is never subject to the self-only rule — verified data is written
  // as it stands, even for a genuine solo invite.
  if (named.length > 0) return { value: named.join(', '), tier: 1 };

  const speakers = extractTranscriptSpeakers(sources.transcript).map(asDisplayName);
  if (speakers.length > 0) {
    if (isSelfOnly(speakers)) return { value: '', tier: 2, selfOnlySuppressed: true };
    return { value: `${speakers.join(', ')} ${TRANSCRIPT_SUFFIX}`, tier: 2 };
  }

  const owners = extractNextStepsOwners(sources.summary).map(asDisplayName);
  if (owners.length > 0) {
    if (isSelfOnly(owners)) return { value: '', tier: 3, selfOnlySuppressed: true };
    return { value: `${owners.join(', ')} ${DERIVED_SUFFIX}`, tier: 3 };
  }

  return { value: '', tier: 4 };
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
  /**
   * Per-fetch transcript SIZE ONLY. The transcript text is fetched, read for
   * speaker labels, and discarded — it never reaches Zoom_Staging, a log line
   * or this artifact. See FathomClient.getTranscript.
   */
  readonly transcriptFetches: readonly { readonly recordingId: string; readonly bytes: number; readonly truncated: boolean }[];
  /** Which ladder tier produced column E, keyed by row, for backfilled rows. */
  readonly participantTiers: Readonly<Record<string, ParticipantTier>>;
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
  // Size and truncation only. The transcript TEXT is never recorded anywhere.
  const transcriptFetches: { recordingId: string; bytes: number; truncated: boolean }[] = [];
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

    // Transcript ONLY when there are no invitees — Tier 1 needs no extra call,
    // and this is a heavy request. Fetched, read for speaker labels, discarded:
    // the text itself never leaves this scope.
    let transcript: string | null = null;
    const hasInvitees = (m.calendar_invitees ?? []).some((iv) => ((iv.name ?? '') + (iv.email ?? '')).trim() !== '');
    if (!hasInvitees && id !== '') {
      try {
        const t = await fathom.getTranscript(id);
        if (t) {
          transcript = t.text;
          transcriptFetches.push({ recordingId: id, bytes: t.bytes, truncated: t.truncated });
          if (t.truncated) {
            warnings.push(`⚠ Transcript for ${id} hit the ${TRANSCRIPT_MAX_BYTES}-byte cap at ${t.bytes} bytes - the speaker list is PARTIAL`);
          }
          const drift = transcriptShapeWarning(id, t.text);
          if (drift) warnings.push(drift);
        }
      } catch (e) {
        warnings.push(`Transcript fetch failed for ${id}: ${String(e)} - falling back to the summary for participants`);
      }
    }
    const who = participantsFor(m, { transcript, summary: md });
    if (who.selfOnlySuppressed) {
      logger.info(`  ${id || k}: derived participants named only the account owner - column E left blank`);
    }
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
        participants: who.value,
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

  const tiers: Record<string, ParticipantTier> = {};

  for (const c of candidates.slice(0, BACKFILL_CAP)) {
    let md: string | null = null;
    try {
      md = await fathom.getSummary(c.recordingId);
    } catch (e) {
      warnings.push(`Backfill summary fetch failed for ${c.recordingId} (row ${c.row}): ${String(e)}`);
      if (c.needsTopline) continue; // no summary and G is what was wanted
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

    // E only when E is blank. Same ladder as the capture path — one
    // implementation, not two. A backfill row has no invitee data to consult
    // (that lives on the meeting payload, not the sheet), so it enters the
    // ladder at Tier 2.
    if (c.needsParticipants) {
      let transcript: string | null = null;
      try {
        const t = await fathom.getTranscript(c.recordingId);
        if (t) {
          transcript = t.text;
          transcriptFetches.push({ recordingId: c.recordingId, bytes: t.bytes, truncated: t.truncated });
          if (t.truncated) {
            warnings.push(`⚠ Transcript for ${c.recordingId} hit the ${TRANSCRIPT_MAX_BYTES}-byte cap at ${t.bytes} bytes - the speaker list is PARTIAL`);
          }
          const drift = transcriptShapeWarning(c.recordingId, t.text);
          if (drift) warnings.push(drift);
        }
      } catch (e) {
        warnings.push(`Transcript fetch failed for ${c.recordingId} (row ${c.row}): ${String(e)} - falling back to the summary for participants`);
      }
      const who = participantsFor({}, { transcript, summary: md });
      tiers[`row ${c.row}`] = who.tier;
      if (who.value !== '') {
        expectE = who.value;
        batch.push({ range: `Zoom_Staging!E${c.row}`, values: [[expectE]] });
        what.push('E');
      } else if (who.selfOnlySuppressed) {
        logger.info(`  row ${c.row} (${c.recordingId}): tier ${who.tier} named only the account owner - column E left blank`);
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
    transcriptFetches,
    participantTiers: tiers,
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
