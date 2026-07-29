/**
 * Slack posting for #aida — routed through Zapier.
 *
 * Every post in #aida goes out under one identity: "Aida", via the same Zapier
 * Slack app the `routines/*.md` files already use. This module POSTs to a
 * Zapier catch-hook, whose Zap performs the Slack "Send Channel Message".
 *
 * Why not post to Slack directly: this used to hit a Slack incoming webhook.
 * Modern Slack-app webhooks silently ignore `username`/`icon_emoji`, so every
 * post from this path landed in #aida under bot B0BJJSXP8MN with no display
 * name at all (confirmed live 2026-07-28), while the Zapier-sourced Zoom posts
 * showed correctly as "Aida". Rather than introduce a third posting identity
 * into the channel, this path now joins the existing Zapier one.
 *
 * KNOWN TRADEOFF — read before trusting a green run: a 2xx here means Zapier
 * ACCEPTED the payload, not that Slack posted it. The Zap runs asynchronously,
 * so a Zap that errors downstream (bad Slack auth, deleted channel, task-limit
 * exhaustion) will not surface as a failure in this process. The previous
 * direct-to-Slack path could confirm delivery end-to-end; this one cannot.
 * If a digest ever goes missing with a clean CI run, check the Zap's task
 * history first — that's where the evidence lives now.
 */

import { requestText, withRetry } from './http.js';

/** Aida's standing identity. Sent on every call so both rails agree. */
export const AIDA_USERNAME = 'Aida';
export const AIDA_ICON_URL = 'https://tnb-c-suite-assets.vercel.app/icons/Aida_EA.jpg';

export interface SlackPoster {
  post(text: string): Promise<void>;
}

export interface SlackPosterConfig {
  /** Zapier catch-hook URL (https://hooks.zapier.com/hooks/catch/...). */
  readonly hookUrl: string;
  readonly username?: string;
  readonly iconUrl?: string;
}

/**
 * `username` and `icon` are the field names Zapier's Slack action expects —
 * NOT Slack's own `icon_url`/`icon_emoji`. Naming the field `icon_url` makes
 * Zapier fail to post or bounce back asking for a URL it was already given.
 */
export function createSlackPoster(config: SlackPosterConfig): SlackPoster {
  const username = config.username ?? AIDA_USERNAME;
  const icon = config.iconUrl ?? AIDA_ICON_URL;

  return {
    async post(text: string): Promise<void> {
      await withRetry(
        () =>
          requestText(config.hookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, username, icon }),
          }),
        { label: 'slack:post' },
      );
    },
  };
}

/** Used when ZAPIER_SLACK_HOOK_URL is unset and in dry-run. */
export function createNoopSlackPoster(onSkip: (text: string) => void): SlackPoster {
  return {
    async post(text: string): Promise<void> {
      onSkip(text);
    },
  };
}
