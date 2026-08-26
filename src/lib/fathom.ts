/**
 * Fathom REST client.
 *
 * Mirrors src/lib/attio.ts: raw REST through lib/http.ts, no SDK, matching this
 * repo's zero-dependency convention (dotenv and zod only). BHC_Zoom.md's
 * DISCOVERY talks to Fathom through an MCP connector, but a GitHub Actions run
 * has no MCP host — same data, different transport, the same substitution the
 * Attio client already documents.
 *
 * Auth is `X-Api-Key`, NOT a Bearer token. Base https://api.fathom.ai/external/v1
 *
 * RATE LIMITS ARE THE DESIGN CONSTRAINT HERE, not an edge case:
 *   - global 60 requests / 60s
 *   - HEAVY 30 / 60s, degrading to 5 / 60s under elevated load
 *
 * "Heavy" covers the summary and transcript endpoints AND `/meetings` with
 * `include_summary=true` — so the ordinary sweep call is itself a heavy
 * request, which is why the backfill is capped per run rather than looping
 * until done. 429s carry `Retry-After` and honouring it is mandatory;
 * lib/http.ts's `withRetry` now reads that header (it previously used a fixed
 * 5s floor and ignored what the server asked for), so nothing rate-limit
 * related is reimplemented in this file.
 */

import { requestJson, withRetry, type RetryOptions } from './http.js';

export const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

export interface FathomClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly onRetry?: RetryOptions['onRetry'];
}

/**
 * One meeting as `/meetings` returns it. Deliberately loose: every field is
 * optional because the sweep must survive a payload shape drifting, and
 * `recording_id` absent is a fact the pass reports rather than a crash.
 */
export interface FathomMeeting {
  readonly recording_id?: string | number;
  readonly title?: string;
  readonly meeting_title?: string;
  readonly url?: string;
  readonly share_url?: string;
  readonly created_at?: string;
  readonly scheduled_start_time?: string;
  readonly scheduled_end_time?: string;
  readonly recording_start_time?: string;
  readonly recording_end_time?: string;
  readonly meeting_type?: string;
  readonly calendar_invitees?: readonly FathomInvitee[];
  readonly recorded_by?: unknown;
  readonly default_summary?: FathomSummary | string | null;
  readonly summary?: FathomSummary | string | null;
  readonly action_items?: readonly unknown[];
  readonly crm_matches?: readonly unknown[];
}

export interface FathomInvitee {
  readonly name?: string;
  readonly email?: string;
}

export interface FathomSummary {
  readonly markdown_formatted?: string;
}

export interface ListMeetingsOptions {
  /** ISO-8601. The API filters server-side; the pass also re-checks locally. */
  readonly createdAfter?: string;
  /**
   * Requesting the summary makes this a HEAVY request (30/60s, degrading to
   * 5/60s). Worth it: it is the whole reason DISCOVERY can fill column G at
   * capture time instead of leaving triage to guess.
   */
  readonly includeSummary?: boolean;
  readonly limit?: number;
}

export class FathomClient {
  constructor(private readonly opts: FathomClientOptions) {}

  private get headers(): Record<string, string> {
    return {
      'X-Api-Key': this.opts.apiKey,
      'Content-Type': 'application/json',
    };
  }

  private request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = (this.opts.baseUrl ?? FATHOM_API_BASE).replace(/\/$/, '');
    const url = `${base}${path}`;
    return withRetry(() => requestJson<T>(url, { ...init, headers: this.headers }), {
      label: `fathom ${path}`,
      ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}),
    });
  }

  /**
   * Recent meetings, newest first as the API returns them.
   *
   * Paginates on `next_cursor` but stops at `limit` — an unbounded loop here
   * would spend the heavy-request budget on history the 24h lookback discards
   * anyway.
   */
  async listMeetings(opts: ListMeetingsOptions = {}): Promise<FathomMeeting[]> {
    const limit = opts.limit ?? 50;
    const out: FathomMeeting[] = [];
    let cursor: string | undefined;

    for (;;) {
      const params = new URLSearchParams();
      if (opts.createdAfter) params.set('created_after', opts.createdAfter);
      if (opts.includeSummary) params.set('include_summary', 'true');
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();

      const res = await this.request<{ items?: unknown[]; next_cursor?: string | null }>(
        `/meetings${qs ? `?${qs}` : ''}`,
      );
      const page = Array.isArray(res.items) ? res.items : [];
      for (const raw of page) {
        if (raw && typeof raw === 'object') out.push(raw as FathomMeeting);
        if (out.length >= limit) return out;
      }

      const next = res.next_cursor;
      if (!next || page.length === 0) return out;
      cursor = next;
    }
  }

  /**
   * One recording's summary. HEAVY. Used only by the backfill, one call per
   * row, capped by the caller — never in a loop over everything blank.
   *
   * Returns null rather than throwing when the summary simply is not ready
   * yet: a meeting still processing is the ordinary case the backfill exists
   * to pick up on a later sweep, not an error.
   */
  async getSummary(recordingId: string): Promise<string | null> {
    const res = await this.request<{ summary?: FathomSummary | string | null }>(
      `/recordings/${encodeURIComponent(recordingId)}/summary`,
    );
    return summaryMarkdown(res.summary);
  }
}

/**
 * Pull the markdown out of whichever summary shape arrived. The list call and
 * the per-recording call disagree — one nests under `markdown_formatted`, and
 * a bare string turns up too — so this normalises before any parsing.
 */
export function summaryMarkdown(summary: FathomSummary | string | null | undefined): string | null {
  if (summary === null || summary === undefined) return null;
  if (typeof summary === 'string') return summary.trim() === '' ? null : summary;
  const md = summary.markdown_formatted;
  if (typeof md !== 'string' || md.trim() === '') return null;
  return md;
}
