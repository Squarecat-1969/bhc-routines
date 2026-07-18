/**
 * Minimal Anthropic Messages API client.
 *
 * Same style as AttioClient/SheetsClient — a hand-rolled fetch wrapper, not
 * the SDK, consistent with the rest of this codebase. PASS 2's enrichment
 * call is the only consumer so far; kept deliberately narrow rather than a
 * general-purpose client, matching the project's own stated principle:
 * "LLM calls stay narrow. Single-purpose Anthropic API calls with a fixed
 * JSON schema, one well-defined task each."
 */

import { requestJson, withRetry, type RetryOptions } from './http.js';

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly onRetry?: RetryOptions['onRetry'];
}

export interface CompleteOptions {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class AnthropicClient {
  constructor(private readonly opts: AnthropicClientOptions) {}

  /** Returns the concatenated text content of the response. Throws on a non-2xx or an empty/malformed response shape. */
  async complete(input: CompleteOptions): Promise<string> {
    const url = `${(this.opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
    const res = await withRetry(
      () =>
        requestJson<MessagesResponse>(url, {
          method: 'POST',
          headers: {
            'x-api-key': this.opts.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            max_tokens: input.maxTokens,
            system: input.system,
            messages: [{ role: 'user', content: input.user }],
          }),
        }),
      { label: 'anthropic:messages', ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}) },
    );

    const text = (res.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    if (text === '') {
      throw new Error('Anthropic response had no text content — unexpected shape');
    }
    return text;
  }
}
