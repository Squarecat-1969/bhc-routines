export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }
}

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
      // Attio asks for a 5s pause on rate limits (spec 4.5b); honour that floor.
      const rateLimited = error instanceof HttpError && error.status === 429;
      const delayMs = rateLimited ? 5_000 : baseDelayMs * 2 ** (attempt - 1);
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
    if (!res.ok) throw new HttpError(res.status, url, text);
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
    if (!res.ok) throw new HttpError(res.status, url, text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
