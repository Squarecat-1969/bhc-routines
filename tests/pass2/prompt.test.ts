import { describe, expect, it } from 'vitest';

import { buildEnrichmentUserPrompt, ENRICHMENT_SYSTEM_PROMPT } from '../../src/passes/pass2/prompt.js';
import type { ContactContext } from '../../src/passes/pass2/prompt.js';
import type { RawEmailMessage } from '../../src/passes/pass2/types.js';

function msg(opts: Partial<RawEmailMessage>): RawEmailMessage {
  return {
    recordId: '', emailMsgId: '1', receivedAt: '2026-07-18T00:00:00Z', sourceMailbox: '', direction: 'Inbound',
    senderName: 'Alice', senderEmail: 'alice@x.com', recipientName: '', recipientEmail: '', ccEmails: [],
    subject: 'Hello', body: 'Hey there', threadId: '',
    ...opts,
  };
}

describe('ENRICHMENT_SYSTEM_PROMPT', () => {
  it('includes the outbound-ceiling rule language', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('OUTBOUND-THREAD CEILING RULE');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('almost always wrong');
  });

  it('includes the hard data guardrail reminder', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('HARD DATA GUARDRAIL');
  });

  it('instructs against markdown fences and preamble', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT.toLowerCase()).toContain('no markdown fences');
  });

  it('warns explicitly against a participant-keyed object for key_commitments', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('NEVER a JSON object keyed by person name');
  });

  it('does not tell the model to assume every thread is a genuine relationship thread — found on a real production run where this framing discouraged NO_ACTION', () => {
    // The old text ("Treat it as a genuine relationship thread worth enriching")
    // actively discouraged the model from ever choosing NO_ACTION, even for
    // cold-outreach/automated content that slipped past deterministic triage.
    expect(ENRICHMENT_SYSTEM_PROMPT).not.toContain('Treat it as a genuine relationship thread worth enriching');
  });

  it('includes explicit cold-outreach and automated-notice classification guidance', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('COLD OUTREACH AND AUTOMATED NOTICES');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('NO_ACTION, not FYI_ONLY');
  });

  it('gives a concrete decision test for the ambiguous cold/automated case', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('would he actually want to see this in his morning digest');
  });
});

describe('buildEnrichmentUserPrompt', () => {
  it('includes the thread direction', () => {
    const prompt = buildEnrichmentUserPrompt([msg({})], 'Inbound', null);
    expect(prompt).toContain('Thread direction: Inbound');
  });

  it('includes message content', () => {
    const prompt = buildEnrichmentUserPrompt([msg({ subject: 'Re: catching up', body: 'Great to hear from you' })], 'Inbound', null);
    expect(prompt).toContain('Re: catching up');
    expect(prompt).toContain('Great to hear from you');
  });

  it('notes no context when contactContext is null', () => {
    const prompt = buildEnrichmentUserPrompt([msg({})], 'Inbound', null);
    expect(prompt).toContain('No prior contact context available');
  });

  it('includes contact context fields when present', () => {
    const ctx: ContactContext = {
      contactName: 'Alice Nguyen',
      personalNotes: 'Has two kids',
      topicsOfInterest: 'Sailing',
      conversationTrigger: '',
      attioPersonalNotes: '',
      attioTopicsOfInterest: '',
      attioConversationTrigger: '',
    };
    const prompt = buildEnrichmentUserPrompt([msg({})], 'Inbound', ctx);
    expect(prompt).toContain('Alice Nguyen');
    expect(prompt).toContain('Has two kids');
    expect(prompt).toContain('Sailing');
  });

  it('omits empty context fields rather than printing blank lines for them', () => {
    const ctx: ContactContext = {
      contactName: 'Bob',
      personalNotes: '', topicsOfInterest: '', conversationTrigger: '',
      attioPersonalNotes: '', attioTopicsOfInterest: '', attioConversationTrigger: '',
    };
    const prompt = buildEnrichmentUserPrompt([msg({})], 'Inbound', ctx);
    expect(prompt).not.toContain('Known personal notes');
  });

  it('includes multiple messages in order', () => {
    const messages = [msg({ emailMsgId: '1', subject: 'First' }), msg({ emailMsgId: '2', subject: 'Second' })];
    const prompt = buildEnrichmentUserPrompt(messages, 'Inbound', null);
    expect(prompt.indexOf('First')).toBeLessThan(prompt.indexOf('Second'));
  });
});
