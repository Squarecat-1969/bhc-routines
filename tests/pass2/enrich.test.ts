import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../../src/lib/anthropic.js';
import { enrichThread } from '../../src/passes/pass2/enrich.js';
import type { RawEmailMessage } from '../../src/passes/pass2/types.js';
import { FakeAnthropicBackend } from '../helpers/fake-anthropic.js';

const VALID_RESPONSE = {
  running_summary: 'Caught up on the project.',
  key_commitments: 'Alice to send the deck by Friday.',
  personal_details_flag: false,
  company_intel: '',
  pipeline_signals: '',
  brain_notes: '',
  action_required: 'FYI_ONLY',
  outcome: 'Neutral',
  response_draft: '',
  tasks: [],
  ready_to_archive: false,
  personal_notes_extract: '',
  topics_of_interest_extract: '',
  conversation_trigger_extract: '',
};

function msg(opts: Partial<RawEmailMessage> = {}): RawEmailMessage {
  return {
    recordId: '', emailMsgId: '1', receivedAt: '2026-07-18T00:00:00Z', sourceMailbox: '', direction: 'Inbound',
    senderName: 'Alice', senderEmail: 'alice@x.com', recipientName: '', recipientEmail: '', ccEmails: [],
    subject: 'Hello', body: 'Hey there', threadId: '',
    ...opts,
  };
}

async function withFakeAnthropic<T>(responseText: string, fn: (anthropic: AnthropicClient) => Promise<T>): Promise<T> {
  const backend = new FakeAnthropicBackend({ responseText });
  const { baseUrl } = await backend.start();
  const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl });
  try {
    return await fn(anthropic);
  } finally {
    await backend.stop();
  }
}

describe('enrichThread — happy path', () => {
  it('returns a validated result for a clean response', async () => {
    const outcome = await withFakeAnthropic(JSON.stringify(VALID_RESPONSE), (anthropic) =>
      enrichThread(anthropic, [msg()], 'Inbound', null),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.response.action_required).toBe('FYI_ONLY');
      expect(outcome.result.warnings).toHaveLength(0);
    }
  });
});

describe('enrichThread — outbound-ceiling guard', () => {
  it('downgrades REPLY_NEEDED to FYI_ONLY on an Outbound thread, with a warning', async () => {
    const modelSaidReplyNeeded = { ...VALID_RESPONSE, action_required: 'REPLY_NEEDED', response_draft: 'Hey, following up—Bobby' };
    const outcome = await withFakeAnthropic(JSON.stringify(modelSaidReplyNeeded), (anthropic) =>
      enrichThread(anthropic, [msg({ direction: 'Outbound' })], 'Outbound', null),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.response.action_required).toBe('FYI_ONLY');
      expect(outcome.result.response.response_draft).toBe('');
      expect(outcome.result.warnings.some((w) => w.includes('outbound-ceiling guard'))).toBe(true);
    }
  });

  it('does NOT fire the guard for REPLY_NEEDED on an Inbound thread', async () => {
    const replyNeeded = { ...VALID_RESPONSE, action_required: 'REPLY_NEEDED', response_draft: 'Sounds good—Bobby' };
    const outcome = await withFakeAnthropic(JSON.stringify(replyNeeded), (anthropic) =>
      enrichThread(anthropic, [msg({ direction: 'Inbound' })], 'Inbound', null),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.response.action_required).toBe('REPLY_NEEDED');
      expect(outcome.result.warnings).toHaveLength(0);
    }
  });

  it('does not fire for ACTION_ITEM on an Outbound thread (only REPLY_NEEDED is guarded)', async () => {
    const actionItem = { ...VALID_RESPONSE, action_required: 'ACTION_ITEM' };
    const outcome = await withFakeAnthropic(JSON.stringify(actionItem), (anthropic) =>
      enrichThread(anthropic, [msg({ direction: 'Outbound' })], 'Outbound', null),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.response.action_required).toBe('ACTION_ITEM');
  });
});

describe('enrichThread — guardrail redaction on output', () => {
  it('redacts sensitive content the model echoed into a field, with a warning', async () => {
    const leaked = { ...VALID_RESPONSE, brain_notes: 'Mentioned SSN 123-45-6789 in passing' };
    const outcome = await withFakeAnthropic(JSON.stringify(leaked), (anthropic) =>
      enrichThread(anthropic, [msg()], 'Inbound', null),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.response.brain_notes).not.toContain('123-45-6789');
      expect(outcome.result.response.brain_notes).toContain('[REDACTED_SSN]');
      expect(outcome.result.warnings.some((w) => w.includes('guardrail redacted'))).toBe(true);
    }
  });

  it('leaves clean output untouched with no warnings', async () => {
    const outcome = await withFakeAnthropic(JSON.stringify(VALID_RESPONSE), (anthropic) =>
      enrichThread(anthropic, [msg()], 'Inbound', null),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.warnings).toHaveLength(0);
  });
});

describe('enrichThread — failure handling', () => {
  it('returns ok:false (never throws) on a malformed response', async () => {
    const outcome = await withFakeAnthropic('not valid json', (anthropic) => enrichThread(anthropic, [msg()], 'Inbound', null));
    expect(outcome.ok).toBe(false);
  });

  it('returns ok:false (never throws) on an API failure', async () => {
    const backend = new FakeAnthropicBackend({ responseText: '', failWith: 500 });
    const { baseUrl } = await backend.start();
    const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl });
    try {
      const outcome = await enrichThread(anthropic, [msg()], 'Inbound', null);
      expect(outcome.ok).toBe(false);
    } finally {
      await backend.stop();
    }
  }, 15_000);
});
