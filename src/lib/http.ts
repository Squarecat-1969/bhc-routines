export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /**
     * `Retry-After` as milliseconds, when the response carried one. Optional
     * because most endpoints here never send it; a 429 without it falls back
     * to the fixed floor in `withRetry`.
     */
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }
}

/**
 * `Retry-After` per RFC 9110: either delay-seconds or an HTTP-date. Both forms
 * are accepted because a server may send either and guessing wrong means
 * hammering an endpoint that just asked to be left alone.
 *
 * Returns undefined for absent/garbage values, and clamps to 120s: a
 * pathological Retry-After (or a clock skew making a date look far future)
 * should not park a scheduled run for an hour holding a job slot.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const raw = header.trim();
  if (raw === '') return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  // A date already in the past means "retry now", not "retry in the past".
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

const MAX_RETRY_AFTER_MS = 120_000;

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly label?: string;
  readonly onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return RETRYABLE_STATUS.has(error.status);
  // Network-level failures (DNS, socket resets, timeouts) surface as TypeError from fetch.
  return error instanceof TypeError;
}

/** Retry with exponential backoff. Non-retryable errors (4xx auth/validation) throw immediately. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      // A server-supplied Retry-After always wins. Fathom's heavy-request
      // budget (30/60s, degrading to 5/60s under load) is communicated this
      // way, and backing off on our own schedule instead of theirs is how a
      // rate limit turns into a longer rate limit. Attio asks for a 5s pause
      // on rate limits (spec 4.5b); that stays the floor when no header came.
      const rateLimited = error instanceof HttpError && error.status === 429;
      const serverAsked = error instanceof HttpError ? error.retryAfterMs : undefined;
      const delayMs = serverAsked ?? (rateLimited ? 5_000 : baseDelayMs * 2 ** (attempt - 1));
      opts.onRetry?.({ attempt, error, delayMs });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit,
  timeoutMs = 60_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text, parseRetryAfter(res.headers.get('retry-after')));
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same success/retry semantics as `requestJson`, but returns the raw response
 * body instead of parsing it as JSON. Slack's incoming-webhook endpoint returns
 * the literal text "ok" on success — JSON.parse-ing that throws, which wrongly
 * turns a successful post into a crashed run. Use this for any endpoint whose
 * response body isn't JSON.
 */
export async function requestText(url: string, init: RequestInit, timeoutMs = 60_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text, parseRetryAfter(res.headers.get('retry-after')));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like `requestText`, but stops reading once `maxBytes` have arrived and
 * reports whether it truncated.
 *
 * Exists for Fathom transcripts, which grow with meeting length (~1KB per
 * minute, measured) and have no upper bound. The cap is a safety valve, not a
 * normal path: a 33-minute meeting is ~30KB. Streaming the cap rather than
 * slicing after the fact means a pathological response never lands in memory
 * in full.
 *
 * A truncated body is returned, NOT thrown — a long meeting must degrade to a
 * partial speaker list rather than to an error.
 */
export async function requestTextCapped(
  url: string,
  init: RequestInit,
  maxBytes: number,
  timeoutMs = 60_000,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new HttpError(res.status, url, body, parseRetryAfter(res.headers.get('retry-after')));
    }
    if (!res.body) {
      const text = await res.text();
      return { text, bytes: Buffer.byteLength(text), truncated: false };
    }

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (bytes + value.byteLength > maxBytes) {
        chunks.push(Buffer.from(value.subarray(0, maxBytes - bytes)));
        bytes = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
  } finally {
    clearTimeout(timer);
  }
}
