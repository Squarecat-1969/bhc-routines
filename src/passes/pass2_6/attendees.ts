/**
 * Attendee extraction — three paths, all required, measured 25 / 8 / 39 across
 * the 72 August 2026 events and re-measured identical on 2026-09-01.
 *
 * ⚠ THIS FILE IS THE ONLY PLACE THE PRIVILEGED BODY IS READ, AND IT NEVER
 * RETURNS IT. `extractParticipants` takes a RawCalendarEvent, reads
 * `body.content` for path 2, and returns addresses and the subject — nothing
 * else. The body does not appear in the return type, so it cannot leave here
 * by accident; carrying it forward would be a compile error, not a review
 * finding.
 *
 * Path 3 does NOT parse a name out of the subject. It returns the subject text
 * and lets identity resolution scan KNOWN contact names against it. That
 * inversion is deliberate: guessing where a name sits in "Lunch w Brian
 * Johnson" invites a fuzzy match, and §5 of the build brief requires the
 * opposite — exact or near-exact against a known contact, never a guess.
 */

import { bodyContentOf, type RawCalendarEvent } from '../../lib/calendar.js';

/** Which of the three paths yielded something for one event. */
export interface ExtractionPaths {
  readonly native: boolean;
  readonly body: boolean;
  readonly subject: boolean;
}

export interface ExtractedParticipants {
  /** Lower-cased, de-duplicated email addresses from paths 1 and 2. */
  readonly addresses: readonly string[];
  /** Display names seen alongside those addresses. Never body prose. */
  readonly names: readonly string[];
  /** The event subject — path 3's haystack. NOT privileged; safe to carry. */
  readonly subject: string;
  readonly paths: ExtractionPaths;
}

const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * The path-2 block, as it actually arrives. The addendum documents it as plain
 * text:
 *
 *     Attendees:
 *     Organizer: - bobbyhougham@gmail.com
 *     - nicklamb@insnw.com Status: needsAction
 *
 * ⚠ MEASURED 2026-09-01: the live body is HTML, and the tags are interleaved
 * with the block —
 *
 *     Attendees:</p>
 *     Organizer: - someone@example.com
 *     <p>- other@example.com Status: needsAction<br>
 *
 * A parser written to the documented plain-text shape would still work here by
 * accident (the addresses survive), but a line-anchored one would not. This
 * scans the block for addresses rather than matching line structure, so the
 * markup is irrelevant.
 */
const ATTENDEE_BLOCK_RE = /Attendees:/i;

/**
 * Where the attendee block stops. Both observed bodies continue into unrelated
 * privileged prose after a `---` separator (a Zoom invitation blob in one case,
 * an event description in the other), so the scan is bounded rather than
 * running to the end of the body.
 */
const BLOCK_TERMINATOR_RE = /\n\s*---|\bJoin Zoom Meeting\b|\bEvent Name\b/i;

/**
 * Reads the body. Returns addresses. The body itself never crosses this
 * boundary — see the file header.
 */
export function extractParticipants(event: RawCalendarEvent): ExtractedParticipants {
  const addresses: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();

  const add = (addr: string | undefined, name?: string): void => {
    const a = (addr ?? '').trim().toLowerCase();
    if (a === '' || seen.has(a)) return;
    seen.add(a);
    addresses.push(a);
    const n = (name ?? '').trim();
    if (n !== '' && !names.includes(n)) names.push(n);
  };

  // ── Path 1 — native attendees[] ─────────────────────────────────────────
  const native = Array.isArray(event.attendees) ? event.attendees : [];
  for (const a of native) add(a.emailAddress?.address, a.emailAddress?.name);
  // The organiser is a participant too and is NOT always in attendees[].
  add(event.organizer?.emailAddress?.address, event.organizer?.emailAddress?.name);
  const nativeHit = addresses.length > 0;

  // ── Path 2 — the attendee block inside the body ─────────────────────────
  // ⚠ The only path that reaches CalendarBridge-synced events, and the only
  // one that touches privileged content. Read, extract, discard.
  let bodyHit = false;
  const body = bodyContentOf(event);
  if (body !== '' && ATTENDEE_BLOCK_RE.test(body)) {
    const start = body.search(ATTENDEE_BLOCK_RE);
    const rest = body.slice(start);
    const stop = rest.search(BLOCK_TERMINATOR_RE);
    const block = stop === -1 ? rest : rest.slice(0, stop);
    const before = addresses.length;
    for (const m of block.match(ADDRESS_RE) ?? []) add(m);
    bodyHit = addresses.length > before || (block.match(ADDRESS_RE) ?? []).length > 0;
  }

  // ── Path 3 — the subject line ───────────────────────────────────────────
  // Returned as a haystack, not parsed. `Lunch w Brian Johnson` is the case
  // that justifies calendar as a source at all — in person, no Zoom link, no
  // guest list, the name only in the subject. Fathom will never see it.
  const subject = String(event.subject ?? '').trim();

  // ⚠ TRY ALL THREE. Do not stop at the first that returns something: a native
  // event can carry both a guest list and a different name in the subject, and
  // they may not be the same set.
  return {
    addresses,
    names,
    subject,
    paths: { native: nativeHit, body: bodyHit, subject: subject !== '' },
  };
}

/**
 * Which single path an event is ATTRIBUTED to for the 25/8/39 census.
 * Attribution is first-hit in path order; extraction itself always runs all
 * three. The two are different questions and conflating them is what would
 * make the census stop matching the brief's measurement.
 */
export function attributePath(event: RawCalendarEvent): 1 | 2 | 3 {
  const nativeCount = Array.isArray(event.attendees) ? event.attendees.length : 0;
  if (nativeCount > 0) return 1;
  const body = bodyContentOf(event);
  if (body !== '' && ATTENDEE_BLOCK_RE.test(body)) return 2;
  return 3;
}
