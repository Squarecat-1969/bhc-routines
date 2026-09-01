/**
 * Fixtures built from the REAL response shape, measured 2026-09-01 against the
 * deployed calendar route over August 2026 (72 events, complete: true).
 *
 * ⚠ IDEALISED FIXTURES HAVE THREE TIMES THIS MONTH PRODUCED TESTS THAT PASSED
 * WITHOUT EXERCISING WHAT THEY NAMED — most recently a `calendar_invitees`
 * fixture with no duplicates, against which a dedupe test would have passed
 * with the dedupe deleted. So these carry the awkward parts of the real shape,
 * not a tidied version of it:
 *
 *   · `body` is `{ contentType, content }` — an OBJECT, not a string.
 *   · body content is HTML. The attendee block arrives with `</p>`, `<p>` and
 *     `<br>` interleaved, NOT as the clean plain text the addendum documents.
 *   · `bodyPreview` exists as a separate top-level string — a truncated body,
 *     and a second privileged field the build brief does not name.
 *   · `start.dateTime` has SEVEN fractional-second digits and no zone suffix;
 *     the zone is in the sibling `timeZone` field.
 *   · the attendee block runs into unrelated privileged prose after a `---`.
 *
 * Addresses are substituted. The SHAPE is real; the people are not.
 */

import type { RawCalendarEvent } from '../../src/lib/calendar.js';

/** A sentinel that must never appear in anything written or logged. */
export const PRIVILEGED_MARKER = 'ATTORNEY-CLIENT-PRIVILEGED-COMMISSION-143297';

const PRIVILEGED_PROSE =
  `<p>Redline comments on the transition agreement. Outstanding commission balance ` +
  `$143,297.38 against the debt schedule. ${PRIVILEGED_MARKER}. This message is ` +
  `subject to attorney-client privilege.</p>`;

/** PATH 1 — native attendees[]. 25 of 72. */
export const NATIVE_EVENT: RawCalendarEvent = {
  id: 'AAMkAGnative001',
  subject: 'EGSM RFP update',
  body: { contentType: 'html', content: `<html><body>${PRIVILEGED_PROSE}</body></html>` },
  bodyPreview: `Redline comments on the transition agreement. ${PRIVILEGED_MARKER}`,
  start: { dateTime: '2026-08-04T17:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-08-04T18:00:00.0000000', timeZone: 'UTC' },
  attendees: [
    { type: 'required', status: { response: 'accepted', time: '0001-01-01T00:00:00Z' }, emailAddress: { name: 'Sarah Holmes', address: 'sholmes@hmlglaw.com' } },
    { type: 'required', status: { response: 'notResponded', time: '0001-01-01T00:00:00Z' }, emailAddress: { name: 'Lana Hougham', address: 'lana@thenewblank.com' } },
  ],
  organizer: { emailAddress: { name: 'Chuck Granade', address: 'chuck@thenewblank.com' } },
  isOrganizer: false,
  sensitivity: 'private',
  showAs: 'busy',
  isCancelled: false,
  type: 'singleInstance',
  seriesMasterId: null,
  webLink: 'https://outlook.office365.com/x',
};

/**
 * PATH 2 — guest list in the body, `attendees` EMPTY. 8 of 72.
 * HTML interleaving and the `---` run-on are both real.
 */
export const BODY_BLOCK_EVENT: RawCalendarEvent = {
  id: 'AAMkAGbody002',
  subject: 'NICK B LAMB and Bobby Hougham (personal)',
  body: {
    contentType: 'html',
    content:
      `<p>Attendees:</p>\nOrganizer: - bobbyhougham@gmail.com\n` +
      `<p>- nicklamb@insnw.com Status: needsAction<br>\n` +
      `--- Event Name Short One-on-One Location: This is a Zoom web conference. ${PRIVILEGED_MARKER}</p>`,
  },
  bodyPreview: `Attendees: Organizer: - bobbyhougham@gmail.com - nicklamb@insnw.com`,
  start: { dateTime: '2026-08-04T20:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-08-04T21:00:00.0000000', timeZone: 'UTC' },
  attendees: [],
  organizer: { emailAddress: { name: 'Bobby Hougham', address: 'bobbyhougham@gmail.com' } },
  sensitivity: 'private',
  showAs: 'busy',
  isCancelled: false,
  type: 'singleInstance',
  seriesMasterId: null,
};

/**
 * PATH 2 on a RECURRING occurrence — measured live, and the case that makes
 * filter rule 1 require BOTH conditions rather than dropping on recurrence.
 */
export const RECURRING_WITH_EXTERNAL: RawCalendarEvent = {
  id: 'AAMkAGrecur003',
  subject: 'Greenwood Heating Maintenance',
  body: {
    contentType: 'html',
    content:
      `<p>Attendees:</p>\nOrganizer: - bobbyhougham@gmail.com\n` +
      `<p>- service@greenwoodheating.com Status: accepted<br>\n--- ${PRIVILEGED_MARKER}</p>`,
  },
  bodyPreview: 'Attendees: Organizer: - bobbyhougham@gmail.com',
  start: { dateTime: '2026-08-12T15:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-08-12T16:00:00.0000000', timeZone: 'UTC' },
  attendees: [],
  organizer: { emailAddress: { address: 'bobbyhougham@gmail.com' } },
  sensitivity: 'private',
  showAs: 'busy',
  isCancelled: false,
  type: 'occurrence',
  seriesMasterId: 'AAMkAGseries999',
};

/** PATH 3 — subject only. 39 of 72, the LARGEST bucket, and `showAs: "oof"`. */
export const SUBJECT_ONLY_EVENT: RawCalendarEvent = {
  id: 'AAMkAGsubj004',
  subject: 'Lunch w Brian Johnson',
  body: { contentType: 'html', content: '' },
  bodyPreview: '',
  start: { dateTime: '2026-08-07T19:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-08-07T20:30:00.0000000', timeZone: 'UTC' },
  attendees: [],
  sensitivity: 'normal',
  showAs: 'oof',
  isCancelled: false,
  type: 'singleInstance',
  seriesMasterId: null,
};

/** Recurring personal noise — the class rule 1 exists to remove. 37 of 72 are occurrences. */
export const RECURRING_NOISE: RawCalendarEvent = {
  id: 'AAMkAGnoise005',
  subject: 'Lunch (personal)',
  body: { contentType: 'html', content: '' },
  bodyPreview: '',
  start: { dateTime: '2026-08-05T19:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-08-05T20:00:00.0000000', timeZone: 'UTC' },
  attendees: [],
  sensitivity: 'private',
  showAs: 'busy',
  isCancelled: false,
  type: 'occurrence',
  seriesMasterId: 'AAMkAGseries111',
};

/** Internal-only — every participant inside the owned domains. */
export const INTERNAL_ONLY_EVENT: RawCalendarEvent = {
  id: 'AAMkAGinternal006',
  subject: 'TNB standup',
  body: { contentType: 'html', content: '' },
  bodyPreview: '',
  start: { dateTime: '2026-08-06T16:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-08-06T16:30:00.0000000', timeZone: 'UTC' },
  attendees: [
    { emailAddress: { name: 'Lana Hougham', address: 'lana@thenewblank.com' } },
    { emailAddress: { name: 'Chuck Granade', address: 'chuck@thenewblank.com' } },
  ],
  organizer: { emailAddress: { address: 'bobbyhougham@gmail.com' } },
  sensitivity: 'normal',
  showAs: 'busy',
  isCancelled: false,
  type: 'singleInstance',
  seriesMasterId: null,
};

/** Cancelled — evidence of nothing, even with a real external attendee. */
export const CANCELLED_EVENT: RawCalendarEvent = {
  ...NATIVE_EVENT,
  id: 'AAMkAGcancelled007',
  subject: 'Call re: Transition Agreement Revisions',
  isCancelled: true,
};

export const ALL_FIXTURES: readonly RawCalendarEvent[] = [
  NATIVE_EVENT,
  BODY_BLOCK_EVENT,
  RECURRING_WITH_EXTERNAL,
  SUBJECT_ONLY_EVENT,
  RECURRING_NOISE,
  INTERNAL_ONLY_EVENT,
  CANCELLED_EVENT,
];
