import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../src/lib/anthropic.js';
import { FakeAnthropicBackend } from './helpers/fake-anthropic.js';

const REQUEST = { model: 'claude-sonnet-5', system: 'You are helpful.', user: 'Hello', maxTokens: 100 };

describe('AnthropicClient.complete', () => {
  it('returns the concatenated text content on a normal response', async () => {
    const backend = new FakeAnthropicBackend({ responseText: 'hello there' });
    const { baseUrl } = await backend.start();
    const client = new AnthropicClient({ apiKey: 'test', baseUrl });
    try {
      const text = await client.complete(REQUEST);
      expect(text).toBe('hello there');
    } finally {
      await backend.stop();
    }
  });

  it('throws with real diagnostic detail (stop_reason, block types) when content has no text — found on a real production run, previously a bare unexplained error', async () => {
    const backend = new FakeAnthropicBackend({ responseText: '', emptyContent: true, stopReason: 'end_turn' });
    const { baseUrl } = await backend.start();
    const client = new AnthropicClient({ apiKey: 'test', baseUrl });
    try {
      await expect(client.complete(REQUEST)).rejects.toThrow(/stop_reason=end_turn/);
      await expect(client.complete(REQUEST)).rejects.toThrow(/block_types=\[\]/); // content: [] — present, empty
    } finally {
      await backend.stop();
    }
  });

  it('surfaces a non-default stop_reason in the diagnostic (e.g. max_tokens truncation with zero text)', async () => {
    const backend = new FakeAnthropicBackend({ responseText: '', emptyContent: true, stopReason: 'max_tokens' });
    const { baseUrl } = await backend.start();
    const client = new AnthropicClient({ apiKey: 'test', baseUrl });
    try {
      await expect(client.complete(REQUEST)).rejects.toThrow(/stop_reason=max_tokens/);
    } finally {
      await backend.stop();
    }
  });
});
