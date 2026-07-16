/**
 * Civil-date arithmetic.
 *
 * Everything here operates on `CivilDate` — a bare "YYYY-MM-DD" string with no
 * time and no zone. Cadence math is calendar math ("45 days after the last
 * touch"), so modelling it with JS `Date` objects would drag in local-time and
 * DST hazards for no benefit. We convert at the edges (see `parseFlexibleDate`)
 * and stay in civil dates everywhere else.
 */

export type CivilDate = string & { readonly __civilDate?: unique symbol };

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Google Sheets serial dates count days from 1899-12-30 (the Lotus 1-2-3 leap
 * year bug, preserved for compatibility). Matches the spec's `to_date` helper.
 */
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

export function isCivilDate(v: unknown): v is CivilDate {
  return typeof v === 'string' && CIVIL_DATE_RE.test(v);
}

function assertCivil(d: CivilDate): void {
  if (!CIVIL_DATE_RE.test(d)) throw new TypeError(`Not a civil date: ${JSON.stringify(d)}`);
}

function toMs(d: CivilDate): number {
  assertCivil(d);
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
}

function fromMs(ms: number): CivilDate {
  return new Date(ms).toISOString().slice(0, 10) as CivilDate;
}

export function addDays(d: CivilDate, n: number): CivilDate {
  return fromMs(toMs(d) + n * MS_PER_DAY);
}

/** Whole days from `b` to `a` (positive when `a` is later). */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((toMs(a) - toMs(b)) / MS_PER_DAY);
}

export function isBefore(a: CivilDate, b: CivilDate): boolean {
  return toMs(a) < toMs(b);
}

export function isSameOrBefore(a: CivilDate, b: CivilDate): boolean {
  return toMs(a) <= toMs(b);
}

/** The current civil date in an IANA timezone. `en-CA` formats as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): CivilDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  if (!CIVIL_DATE_RE.test(parts)) {
    throw new Error(`Could not resolve today in timezone ${timeZone} (got ${parts})`);
  }
  return parts as CivilDate;
}

/**
 * Coerce whatever a Sheet cell or an Attio field hands us into a CivilDate.
 * Mirrors the spec's `to_date`: serial numbers (raw or stringified) first, then
 * ISO-8601. Anything unparseable is `null` — never a guess.
 *
 * Note: an ISO *datetime* is reduced by its UTC date, matching the spec's
 * `datetime.fromisoformat(...).date()`. A timestamp of 2026-06-02T00:30:00Z is
 * therefore 2026-06-02, even though it is still June 1st in Los Angeles.
 */
export function parseFlexibleDate(v: unknown): CivilDate | null {
  if (v === null || v === undefined || v === '') return null;

  if (typeof v === 'number' && Number.isFinite(v)) {
    return fromMs(SHEETS_EPOCH_MS + v * MS_PER_DAY);
  }

  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;

  // Serial-as-string, e.g. "45812" or "45812.5".
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return fromMs(SHEETS_EPOCH_MS + Number(s) * MS_PER_DAY);
  }

  if (CIVIL_DATE_RE.test(s)) return s as CivilDate;

  const parsed = new Date(s.replace(/Z$/, '+00:00'));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) as CivilDate;
}

export function iso(d: CivilDate | null): string {
  return d ?? '';
}
