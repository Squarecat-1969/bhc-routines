/**
 * Slack posting for the #aida addendum.
 *
 * Every post carries username "Aida" and icon ":aida:" — the standing bot
 * identity for this system (spec: Authentication → Slack).
 */

import { requestText, withRetry } from './http.js';

export interface SlackPoster {
  post(text: string): Promise<void>;
}

export function createSlackPoster(webhookUrl: string): SlackPoster {
  return {
    async post(text: string): Promise<void> {
      await withRetry(
        () =>
          requestText(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, username: 'Aida', icon_emoji: ':aida:' }),
          }),
        { label: 'slack:post' },
      );
    },
  };
}

/** Used when SLACK_WEBHOOK_URL is unset and in dry-run. */
export function createNoopSlackPoster(onSkip: (text: string) => void): SlackPoster {
  return {
    async post(text: string): Promise<void> {
      onSkip(text);
    },
  };
}
