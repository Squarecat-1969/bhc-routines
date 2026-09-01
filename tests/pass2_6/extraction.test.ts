/**
 * Attendee extraction and the noise filter — pure, no credentials.
 *
 * The privileged-content tests are the load-bearing ones. Everything else here
 * can be fixed later; a body reaching a written value cannot.
 */

import { describe, expect, it } from 'vitest';

import { attributePath, extractParticipants } from '../../src/passes/pass2_6/attendees.js';
import { applyNoiseFilter, isExternalAddress } from '../../src/passes/pass2_6/filter.js';
import { normalizeGraphDateTime, toSafeEvent } from '../../src/lib/calendar.js';
import {
  ALL_FIXTURES,
  BODY_BLOCK_EVENT,
  CANCELLED_EVENT,
  INTERNAL_ONLY_EVENT,
  NATIVE_EVENT,
  PRIVILEGED_MARKER,
  RECURRING_NOISE,
  RECURRING_WITH_EXTERNAL,
  SUBJECT_ONLY_EVENT,
} from './fixtures.js';

describe('⚠ the privileged body reaches nothing', () => {
  it('extraction returns addresses and subject — and NO field capable of holding the body', () => {
    const p = extractParticipants(NATIVE_EVENT);
    expect(JSON.stringify(p)).not.toContain(PRIVILEGED_MARKER);
    expect(Object.keys(p).sort()).toEqual(['addresses', 'names', 'paths', 'subject']);
  });

  it('holds for the path-2 event, where the body is READ to find the guest list', () => {
    // This is the only path that touches privileged content, so it is the one
    // that matters: the addresses come out, the prose after `---` does not.
    const p = extractParticipants(BODY_BLOCK_EVENT);
    expect(p.addresses).toContain('nicklamb@insnw.com');
    expect(JSON.stringify(p)).not.toContain(PRIVILEGED_MARKER);
    expect(JSON.stringify(p)).not.toContain('Zoom web conference');
  });

  it('toSafeEvent drops BOTH body and bodyPreview — bodyPreview is a truncated body, not a summary', () => {
    const safe = toSafeEvent(NATIVE_EVENT);
    expect(JSON.stringify(safe)).not.toContain(PRIVILEGED_MARKER);
    expect(safe).not.toHaveProperty('body');
    expect(safe).not.toHaveProperty('bodyPreview');
  });

  it('no fixture leaks through extraction OR the safe shape — swept, not spot-checked', () => {
    for (const ev of ALL_FIXTURES) {
      const blob = JSON.stringify({ p: extractParticipants(ev), s: toSafeEvent(ev) });
      expect(blob).not.toContain(PRIVILEGED_MARKER);
      expect(blob).not.toContain('attorney-client');
      expect(blob).not.toContain('143,297');
    }
  });
});

describe('path 1 — native attendees[]', () => {
  it('takes every attendee address plus the organiser', () => {
    const p = extractParticipants(NATIVE_EVENT);
    expect(p.addresses).toEqual(['sholmes@hmlglaw.com', 'lana@thenewblank.com', 'chuck@thenewblank.com']);
    expect(p.names).toContain('Sarah Holmes');
    expect(p.paths.native).toBe(true);
  });

  it('includes the organiser, who is NOT always in attendees[]', () => {
    // isOrganizer: false on this event — the organiser is a third party and a
    // real participant. Dropping them loses a participant on every invited-to
    // meeting.
    expect(extractParticipants(NATIVE_EVENT).addresses).toContain('chuck@thenewblank.com');
  });
});

describe('path 2 — the guest list inside the body', () => {
  it('parses the block through interleaved HTML, which is how it really arrives', () => {
    const p = extractParticipants(BODY_BLOCK_EVENT);
    expect(p.addresses).toEqual(['bobbyhougham@gmail.com', 'nicklamb@insnw.com']);
    expect(p.paths.body).toBe(true);
  });

  it('stops at the `---` separator and does not run into the prose after it', () => {
    // The real bodies continue into a Zoom invitation or an event description
    // after `---`. An unbounded scan would pull addresses out of that prose.
    const p = extractParticipants(BODY_BLOCK_EVENT);
    expect(p.addresses).toHaveLength(2);
  });
});

describe('path 3 — the subject line', () => {
  it('returns the subject as a haystack rather than parsing a name out of it', () => {
    const p = extractParticipants(SUBJECT_ONLY_EVENT);
    expect(p.addresses).toEqual([]);
    expect(p.subject).toBe('Lunch w Brian Johnson');
    expect(p.paths.subject).toBe(true);
  });
});

describe('all three run — never stop at the first hit', () => {
  it('a native event still carries its subject for path-3 matching', () => {
    // A native event can have a guest list AND a different name in the subject,
    // and they may not be the same set.
    const p = extractParticipants(NATIVE_EVENT);
    expect(p.paths.native).toBe(true);
    expect(p.paths.subject).toBe(true);
    expect(p.subject).toBe('EGSM RFP update');
  });
});

describe('the 25 / 8 / 39 census attribution', () => {
  it('attributes each fixture to the path the brief would count it under', () => {
    expect(attributePath(NATIVE_EVENT)).toBe(1);
    expect(attributePath(BODY_BLOCK_EVENT)).toBe(2);
    expect(attributePath(RECURRING_WITH_EXTERNAL)).toBe(2);
    expect(attributePath(SUBJECT_ONLY_EVENT)).toBe(3);
    expect(attributePath(RECURRING_NOISE)).toBe(3);
  });
});

describe('external-participant test', () => {
  it('treats the company domain and Bobby\'s own gmail as internal', () => {
    expect(isExternalAddress('lana@thenewblank.com')).toBe(false);
    expect(isExternalAddress('bobbyhougham@gmail.com')).toBe(false);
    expect(isExternalAddress('nicklamb@insnw.com')).toBe(true);
    expect(isExternalAddress('sholmes@hmlglaw.com')).toBe(true);
  });

  it('Bobby\'s gmail must be internal, or every synced event looks externally attended', () => {
    // It is the ORGANIZER address on every CalendarBridge-synced event.
    const p = extractParticipants(RECURRING_WITH_EXTERNAL);
    expect(p.addresses).toContain('bobbyhougham@gmail.com');
    expect(isExternalAddress('bobbyhougham@gmail.com')).toBe(false);
  });
});

describe('the noise filter', () => {
  const outcome = (ev: typeof NATIVE_EVENT) =>
    applyNoiseFilter(toSafeEvent(ev), extractParticipants(ev));

  it('drops a recurring occurrence with nobody outside', () => {
    expect(outcome(RECURRING_NOISE)).toEqual({ keep: false, reason: 'recurring_no_external' });
  });

  it('KEEPS a recurring occurrence that has an external participant', () => {
    // Rule 1 requires BOTH conditions. Dropping on recurrence alone would
    // discard real recurring business meetings — measured live, several
    // path-2 events are occurrences with outside addresses.
    expect(outcome(RECURRING_WITH_EXTERNAL)).toEqual({ keep: true, reason: null });
  });

  it('drops an internal-only meeting', () => {
    expect(outcome(INTERNAL_ONLY_EVENT)).toEqual({ keep: false, reason: 'no_external_participant' });
  });

  it('drops a cancelled meeting even with a real external attendee', () => {
    expect(outcome(CANCELLED_EVENT)).toEqual({ keep: false, reason: 'cancelled' });
  });

  it('KEEPS the subject-only event — the case that justifies the whole source', () => {
    // `Lunch w Brian Johnson`: showAs "oof", no guest list, no Zoom link.
    // It has no addresses to judge, so it survives to identity resolution.
    expect(outcome(SUBJECT_ONLY_EVENT)).toEqual({ keep: true, reason: null });
  });

  it('does NOT filter on showAs — an availability test would drop that lunch', () => {
    expect(SUBJECT_ONLY_EVENT.showAs).toBe('oof');
    expect(outcome(SUBJECT_ONLY_EVENT).keep).toBe(true);
  });

  it('does NOT filter on the (personal) suffix — it marks provenance, not subject matter', () => {
    expect(BODY_BLOCK_EVENT.subject).toContain('(personal)');
    expect(outcome(BODY_BLOCK_EVENT).keep).toBe(true);
  });
});

describe('Graph date normalisation', () => {
  it('handles seven fractional digits with the zone in the sibling field', () => {
    expect(normalizeGraphDateTime({ dateTime: '2026-08-01T16:30:00.0000000', timeZone: 'UTC' }))
      .toBe('2026-08-01T16:30:00.000Z');
  });

  it('returns empty rather than a wrong date when the value is missing or unparseable', () => {
    expect(normalizeGraphDateTime(undefined)).toBe('');
    expect(normalizeGraphDateTime({ dateTime: 'not-a-date', timeZone: 'UTC' })).toBe('');
  });
});
