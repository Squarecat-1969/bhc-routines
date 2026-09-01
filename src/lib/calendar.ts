/**
 * Outlook calendar access via the Aida proxy
 * (https://aida.hougham.us/api/brain/calendar).
 *
 * Same shape as src/lib/sheets.ts: POST an { action, ... } body with the
 * BRAIN_API_TOKEN bearer. Graph auth lives entirely in Vercel — this repo holds
 * no Microsoft credential and gains none.
 *
 * ⚠ THE BODY IS PRIVILEGED CONTENT AND IT CROSSES THE NETWORK INTO THIS REPO.
 * Calendar bodies carry entire email threads: a commission balance, debt
 * schedules, an explicit attorney-client privilege notice, payroll figures.
 * The route returns the body because 8 of 72 events carry their guest list
 * there and nowhere else. The route cannot enforce anything once the data
 * leaves it — this repo must.
 *
 * The types below therefore separate TWO shapes on purpose:
 *
 *   RawCalendarEvent — what the wire returns, INCLUDING body and bodyPreview.
 *                      Never store one, never return one from a pass, never
 *                      put one in a report or a log line.
 *   SafeCalendarEvent — the same event with both privileged fields structurally
 *                      ABSENT. Everything downstream takes this.
 *
 * `toSafeEvent` is the only crossing point, and it is a one-way door: it cannot
 * return the body because the return type has nowhere to put it. That is the
 * point — a rule enforced by a type survives a refactor that a rule enforced by
 * a comment does not.
 *
 * ⚠ bodyPreview IS ALSO PRIVILEGED. It is a truncated body, and the standing
 * rule says "not truncated" explicitly. Measured 2026-09-01: it is a separate
 * top-level string field, and it is dropped here alongside `body`.
 */

import { requestJson, withRetry, type RetryOptions } from './http.js';

export interface CalendarClientOptions {
  /** The Aida proxy's calendar route. Derived from SHEETS_PROXY_URL by default. */
  readonly url: string;
  readonly token: string;
  readonly onRetry?: RetryOptions['onRetry'];
}

export interface CalendarAttendee {
  readonly type?: string;
  readonly status?: { readonly response?: string; readonly time?: string };
  readonly emailAddress?: { readonly name?: string; readonly address?: string };
}

export interface CalendarDateTime {
  readonly dateTime?: string;
  readonly timeZone?: string;
}

/**
 * ⚠ CARRIES PRIVILEGED CONTENT. Exists only between the fetch and
 * `toSafeEvent`. Measured field list, 2026-09-01.
 */
export interface RawCalendarEvent {
  readonly id?: string;
  readonly subject?: string;
  /** ⚠ PRIVILEGED. `{ contentType, content }` — content is HTML. */
  readonly body?: { readonly contentType?: string; readonly content?: string } | string | null;
  /** ⚠ PRIVILEGED. A truncated body, and truncation is not a defence. */
  readonly bodyPreview?: string;
  readonly start?: CalendarDateTime;
  readonly end?: CalendarDateTime;
  readonly attendees?: readonly CalendarAttendee[];
  readonly organizer?: CalendarAttendee;
  readonly isOrganizer?: boolean;
  readonly sensitivity?: string;
  readonly showAs?: string;
  readonly isCancelled?: boolean;
  readonly type?: string;
  readonly seriesMasterId?: string | null;
  readonly location?: unknown;
  readonly webLink?: string;
}

/**
 * An event with the privileged fields STRUCTURALLY ABSENT. Everything past
 * attendee extraction takes this type, so carrying a body forward is a
 * compile error rather than a review finding.
 */
export interface SafeCalendarEvent {
  readonly id: string;
  readonly subject: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly isCancelled: boolean;
  readonly type: string;
  readonly seriesMasterId: string | null;
  readonly showAs: string;
  readonly sensitivity: string;
}

export interface ListEventsResult {
  readonly events: readonly RawCalendarEvent[];
  readonly eventCount: number;
  readonly complete: boolean;
  readonly partialReason: string | null;
  readonly subjectlessCount: number;
  readonly pagesFetched: number;
  readonly preReadMs: number;
}

/** The body as a plain string, whichever shape arrived. ⚠ PRIVILEGED — callers must discard. */
export function bodyContentOf(event: RawCalendarEvent): string {
  const b = event.body;
  if (typeof b === 'string') return b;
  if (b && typeof b === 'object' && typeof b.content === 'string') return b.content;
  return '';
}

/**
 * The ONE crossing point out of privileged territory. Returns a shape with no
 * field capable of holding body text.
 */
export function toSafeEvent(event: RawCalendarEvent): SafeCalendarEvent {
  return {
    id: String(event.id ?? ''),
    subject: String(event.subject ?? ''),
    startIso: normalizeGraphDateTime(event.start),
    endIso: normalizeGraphDateTime(event.end),
    isCancelled: event.isCancelled === true,
    type: String(event.type ?? ''),
    seriesMasterId: event.seriesMasterId ?? null,
    showAs: String(event.showAs ?? ''),
    sensitivity: String(event.sensitivity ?? ''),
  };
}

/**
 * Graph returns `{ dateTime: "2026-08-01T16:30:00.0000000", timeZone: "UTC" }`
 * — seven fractional-second digits, which `Date.parse` handles, and NO zone
 * suffix on the string itself. The zone lives in the sibling field, so the bare
 * string must not be trusted as UTC without it.
 */
export function normalizeGraphDateTime(dt: CalendarDateTime | undefined): string {
  const raw = dt?.dateTime;
  if (!raw) return '';
  const zone = dt?.timeZone ?? '';
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : zone.toUpperCase() === 'UTC' ? `${raw}Z` : raw;
  const t = Date.parse(withZone);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

export class CalendarClient {
  constructor(private readonly opts: CalendarClientOptions) {}

  /**
   * ⚠ THE END OF THE RANGE IS EXCLUSIVE — treat the window as [start, end).
   * Measured: Aug01→Sep01 returns 72, Aug01→Sep02 returns 76, the four extras
   * all on September 1. That mismatch cost an hour during route verification.
   *
   * ⚠ CHECK `complete` ON EVERY RESPONSE. A partial page is not a smaller
   * month, it is an UNKNOWN month, and judging against one produces
   * NO_EVIDENCE verdicts for meetings that exist. The caller must skip the run
   * rather than evaluate a truncated set.
   */
  async listEvents(startIso: string, endIso: string): Promise<ListEventsResult> {
    const res = await withRetry(
      () =>
        requestJson<Record<string, unknown>>(
          this.opts.url,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'listEvents', startDateTime: startIso, endDateTime: endIso }),
          },
          180_000,
        ),
      { label: 'calendar:listEvents', ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}) },
    );

    const events = Array.isArray(res['events']) ? (res['events'] as RawCalendarEvent[]) : [];
    return {
      events,
      eventCount: typeof res['eventCount'] === 'number' ? (res['eventCount'] as number) : events.length,
      // Absent `complete` is treated as NOT complete. An unknown window must
      // never read as a known-empty one.
      complete: res['complete'] === true,
      partialReason: typeof res['partialReason'] === 'string' ? (res['partialReason'] as string) : null,
      subjectlessCount: typeof res['subjectlessCount'] === 'number' ? (res['subjectlessCount'] as number) : 0,
      pagesFetched: typeof res['pagesFetched'] === 'number' ? (res['pagesFetched'] as number) : 0,
      preReadMs: typeof res['preReadMs'] === 'number' ? (res['preReadMs'] as number) : 0,
    };
  }
}
