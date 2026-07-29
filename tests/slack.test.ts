/**
 * Guards the identity contract of the #aida poster.
 *
 * Background (2026-07-28): this path used to POST to a Slack incoming webhook.
 * Modern Slack-app webhooks silently drop `username`/`icon_emoji`, so Late
 * Edition, PASS 4, PASS 4.5 and Part D were all landing in #aida with no
 * display name, while the Zapier-sourced Zoom posts showed as "Aida". It now
 * routes through the same Zapier Slack app, so there is exactly one identity
 * in the channel.
 *
 * The field names matter and are easy to get wrong: Zapier's Slack action
 * wants `username` and `icon`. Slack's own API wants `icon_url`/`icon_emoji`.
 * Sending Slack's names to Zapier is a silent no-post, so it's asserted here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/http.js';
import { AIDA_ICON_URL, AIDA_USERNAME, createSlackPoster } from '../src/lib/slack.js';

interface CapturedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function stubFetch(statuses: readonly number[]) {
  const calls: CapturedCall[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const status = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      return new Response(status === 200 ? '{"status":"success"}' : 'error', { status });
    }),
  );
  return calls;
}

const HOOK = 'https://hooks.zapier.com/hooks/catch/123456/abcdef/';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSlackPoster identity', () => {
  it('sends text, username "Aida", and her hosted icon to the Zapier hook', async () => {
    const calls = stubFetch([200]);

    await createSlackPoster({ hookUrl: HOOK }).post('hello #aida');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(calls[0]!.body).toEqual({
      text: 'hello #aida',
      username: AIDA_USERNAME,
      icon: AIDA_ICON_URL,
    });
  });

  it('uses Zapier\u2019s field name `icon`, never Slack\u2019s `icon_url`/`icon_emoji`', async () => {
    const calls = stubFetch([200]);

    await createSlackPoster({ hookUrl: HOOK }).post('hi');

    expect(calls[0]!.body).toHaveProperty('icon');
    expect(calls[0]!.body).not.toHaveProperty('icon_url');
    expect(calls[0]!.body).not.toHaveProperty('icon_emoji');
  });

  it('honours an explicit username/icon override', async () => {
    const calls = stubFetch([200]);

    await createSlackPoster({
      hookUrl: HOOK,
      username: 'Aida (staging)',
      iconUrl: 'https://example.com/x.png',
    }).post('hi');

    expect(calls[0]!.body).toMatchObject({
      username: 'Aida (staging)',
      icon: 'https://example.com/x.png',
    });
  });
});

describe('createSlackPoster failure handling', () => {
  it('throws when Zapier rejects the payload', async () => {
    stubFetch([400]);

    await expect(createSlackPoster({ hookUrl: HOOK }).post('hi')).rejects.toThrow(HttpError);
  });

  it('does not retry a 410 — a turned-off Zap will not recover on its own', async () => {
    const calls = stubFetch([410]);

    await expect(createSlackPoster({ hookUrl: HOOK }).post('hi')).rejects.toThrow(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('retries a 503 and succeeds on a later attempt', async () => {
    const calls = stubFetch([503, 200]);

    await expect(createSlackPoster({ hookUrl: HOOK }).post('hi')).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
