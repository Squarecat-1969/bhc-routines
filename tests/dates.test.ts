import { describe, expect, it } from 'vitest';

import { addDays, diffDays, isBefore, newerOf, normalizeInteractionDate, parseFlexibleDate, todayIn, type CivilDate } from '../src/lib/dates.js';

describe('parseFlexibleDate', () => {
  it('returns null for empty-ish input rather than guessing', () => {
    expect(parseFlexibleDate(null)).toBeNull();
    expect(parseFlexibleDate(undefined)).toBeNull();
    expect(parseFlexibleDate('')).toBeNull();
    expect(parseFlexibleDate('   ')).toBeNull();
    expect(parseFlexibleDate('not a date')).toBeNull();
    expect(parseFlexibleDate({})).toBeNull();
  });

  it('parses Google Sheets serial numbers from the 1899-12-30 epoch', () => {
    expect(parseFlexibleDate(1)).toBe('1899-12-31');
    expect(parseFlexibleDate(45000)).toBe('2023-03-15');
  });

  it('parses serials handed over as strings', () => {
    expect(parseFlexibleDate('45000')).toBe('2023-03-15');
    expect(parseFlexibleDate('45000.75')).toBe('2023-03-15');
  });

  it('passes through plain civil dates', () => {
    expect(parseFlexibleDate('2026-07-15')).toBe('2026-07-15');
  });

  it('reduces an ISO datetime by its UTC date, matching the spec helper', () => {
    expect(parseFlexibleDate('2026-07-15T23:30:00Z')).toBe('2026-07-15');
    // 00:30Z is still July 14th in Los Angeles — we take the UTC date, as the spec does.
    expect(parseFlexibleDate('2026-07-15T00:30:00Z')).toBe('2026-07-15');
    expect(parseFlexibleDate('2026-07-15T12:00:00+02:00')).toBe('2026-07-15');
  });
});

describe('civil date arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-07-30' as CivilDate, 4)).toBe('2026-08-03');
  });

  it('adds days across a year boundary', () => {
    expect(addDays('2026-12-30' as CivilDate, 5)).toBe('2027-01-04');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28' as CivilDate, 1)).toBe('2028-02-29');
    expect(addDays('2028-02-28' as CivilDate, 2)).toBe('2028-03-01');
  });

  it('is unaffected by DST — the spring-forward day is still one day', () => {
    // 2026-03-08 is the US DST transition. A local-time implementation would
    // return 23h here and risk an off-by-one.
    expect(diffDays('2026-03-09' as CivilDate, '2026-03-08' as CivilDate)).toBe(1);
    expect(addDays('2026-03-08' as CivilDate, 1)).toBe('2026-03-09');
  });

  it('measures whole-day differences with sign', () => {
    expect(diffDays('2026-07-15' as CivilDate, '2026-07-01' as CivilDate)).toBe(14);
    expect(diffDays('2026-07-01' as CivilDate, '2026-07-15' as CivilDate)).toBe(-14);
    expect(diffDays('2026-07-15' as CivilDate, '2026-07-15' as CivilDate)).toBe(0);
  });

  it('compares strictly', () => {
    expect(isBefore('2026-07-14' as CivilDate, '2026-07-15' as CivilDate)).toBe(true);
    expect(isBefore('2026-07-15' as CivilDate, '2026-07-15' as CivilDate)).toBe(false);
  });
});

describe('todayIn', () => {
  it('resolves the civil date in the given zone', () => {
    // 06:00 UTC on the 15th is 23:00 on the 14th in Los Angeles — this is exactly
    // the situation every scheduled run is in (11pm PDT = 06:00 UTC next day).
    const at6amUtc = new Date('2026-07-15T06:00:00Z');
    expect(todayIn('UTC', at6amUtc)).toBe('2026-07-15');
    expect(todayIn('America/Los_Angeles', at6amUtc)).toBe('2026-07-14');
  });
});

describe('normalizeInteractionDate — Brain_Complete col H is not one shape', () => {
  // Both values below are REAL, taken from live Brain_Complete rows during the
  // read-only survey that preceded this change. 172 of 173 rows look like row
  // 162; row 49 is the lone bare-date row, and it is precisely the row that
  // would be handled inconsistently if the raw value were passed around.
  it("normalizes row 162's full ISO-8601 timestamp", () => {
    expect(normalizeInteractionDate('2026-08-12T21:11:55.000Z')).toBe('2026-08-12');
  });

  it("normalizes row 49's bare YYYY-MM-DD unchanged", () => {
    expect(normalizeInteractionDate('2026-07-01')).toBe('2026-07-01');
  });

  it('collapses both real shapes to the same form when they name the same day', () => {
    // The actual point of the helper: one day, one representation, whichever
    // shape the sheet happened to store it in.
    expect(normalizeInteractionDate('2026-07-01T23:59:59.000Z')).toBe(normalizeInteractionDate('2026-07-01'));
  });

  it("returns '' for blank, so callers can write it straight into a cell", () => {
    expect(normalizeInteractionDate('')).toBe('');
    expect(normalizeInteractionDate(null)).toBe('');
    expect(normalizeInteractionDate(undefined)).toBe('');
  });

  it("returns '' rather than a guess for something unparseable", () => {
    expect(normalizeInteractionDate('last Tuesday')).toBe('');
    expect(normalizeInteractionDate('not a date')).toBe('');
  });

  it('handles a numeric Sheets serial, the trap this repo has already hit twice', () => {
    // Not a shape col H holds today, but free via parseFlexibleDate — and if
    // the column ever changes render mode this is the failure it prevents.
    expect(normalizeInteractionDate(46246)).toBe('2026-08-12');
  });

  it('reduces an ISO datetime by its UTC date, matching parseFlexibleDate', () => {
    expect(normalizeInteractionDate('2026-06-02T00:30:00Z')).toBe('2026-06-02');
  });
});

describe('newerOf — PASS 4 reads two last-touch fields, either of which may be absent', () => {
  const d = (s: string): CivilDate => s as CivilDate;

  it('returns null when BOTH are null — unknown stays unknown, never coerced to a date', () => {
    expect(newerOf(null, null)).toBeNull();
  });

  it('returns the native value when only native is present', () => {
    expect(newerOf(d('2026-07-15'), null)).toBe('2026-07-15');
  });

  it('returns the manual value when only manual is present', () => {
    // The case the whole change exists for: a contact Attio's sync has never
    // seen, kept alive entirely by WhatsApp/phone/in-person.
    expect(newerOf(null, d('2026-07-30'))).toBe('2026-07-30');
  });

  it('returns native when native is newer', () => {
    expect(newerOf(d('2026-08-01'), d('2026-07-30'))).toBe('2026-08-01');
  });

  it('returns manual when manual is newer', () => {
    expect(newerOf(d('2026-06-22'), d('2026-07-30'))).toBe('2026-07-30');
  });

  it('returns the FIRST argument on an exact tie, so callers encode preference by order', () => {
    // PASS 4 passes native first: when both agree, the more-trusted signal wins
    // and the reason is not marked [manual].
    const tie = d('2026-07-30');
    expect(newerOf(tie, d('2026-07-30'))).toBe(tie);
  });

  it('never invents a date from a null side', () => {
    // Guards the obvious bug: treating null as epoch/"very old" would make a
    // null side lose every comparison instead of being skipped.
    expect(newerOf(null, d('1999-01-01'))).toBe('1999-01-01');
    expect(newerOf(d('1999-01-01'), null)).toBe('1999-01-01');
  });
});
