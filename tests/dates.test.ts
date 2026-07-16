import { describe, expect, it } from 'vitest';

import { addDays, diffDays, isBefore, parseFlexibleDate, todayIn, type CivilDate } from '../src/lib/dates.js';

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
