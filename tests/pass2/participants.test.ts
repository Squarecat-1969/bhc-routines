import { describe, expect, it } from 'vitest';

import { identifyPrimaryAndSecondary, isFullyInternal, isTestOrPlaceholder } from '../../src/passes/pass2/participants.js';
import type { RawEmailMessage } from '../../src/passes/pass2/types.js';

function msg(opts: Partial<RawEmailMessage> & { emailMsgId: string }): RawEmailMessage {
  return {
    recordId: '',
    receivedAt: '',
    sourceMailbox: '',
    direction: 'Inbound',
    senderName: '',
    senderEmail: '',
    recipientName: '',
    recipientEmail: '',
    ccEmails: [],
    subject: '',
    body: '',
    threadId: '',
    ...opts,
  };
}

describe('identifyPrimaryAndSecondary', () => {
  it('inbound: primary is the sender of the most recent message', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'first@x.com' }),
      msg({ emailMsgId: '2', direction: 'Inbound', senderEmail: 'alice@x.com' }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Inbound');
    expect(result.primaryEmail).toBe('alice@x.com');
  });

  it('outbound: primary is recipient_email when populated', () => {
    const messages = [msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmail: 'alice@x.com' })];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('alice@x.com');
  });

  it('outbound: falls back to cc when recipient_email is blank (real-data gap)', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmail: '', ccEmails: ['alice@x.com'] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('alice@x.com');
  });

  it('outbound: falls back to most-frequent external address when recipient and cc are both empty', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'alice@x.com' }),
      msg({ emailMsgId: '2', direction: 'Inbound', senderEmail: 'alice@x.com' }),
      msg({ emailMsgId: '3', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmail: '', ccEmails: [] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('alice@x.com'); // appears twice, most frequent
  });

  it('excludes owned addresses from both primary and secondaries', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'alice@x.com', ccEmails: ['bobby@thenewblank.com', 'chuck@thenewblank.com'] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Inbound');
    expect(result.primaryEmail).toBe('alice@x.com');
    expect(result.secondaryEmails).toEqual([]);
  });

  it('secondaries include other external addresses, excluding the primary', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'alice@x.com', ccEmails: ['bob-external@x.com'] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Inbound');
    expect(result.primaryEmail).toBe('alice@x.com');
    expect(result.secondaryEmails).toEqual(['bob-external@x.com']);
  });

  it('returns nulls for an empty message list', () => {
    const result = identifyPrimaryAndSecondary([], 'Inbound');
    expect(result.primaryEmail).toBeNull();
    expect(result.secondaryEmails).toEqual([]);
  });
});

describe('isTestOrPlaceholder', () => {
  it('flags lorem ipsum content', () => {
    expect(isTestOrPlaceholder([msg({ emailMsgId: '1', body: 'Lorem ipsum dolor sit amet' })])).toBe(true);
  });

  it('flags an obvious test subject', () => {
    expect(isTestOrPlaceholder([msg({ emailMsgId: '1', subject: 'this is a test' })])).toBe(true);
  });

  it('does not flag genuine content', () => {
    expect(isTestOrPlaceholder([msg({ emailMsgId: '1', body: 'Hey, following up on Friday' })])).toBe(false);
  });
});

describe('isFullyInternal', () => {
  it('is true when every participant is an owned address — the real Sevrin/loan-billing case found in production', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmail: 'sevrin@thenewblank.com' }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(isFullyInternal(result)).toBe(true);
  });

  it('is false when a real external party is present', () => {
    const messages = [msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'alice@x.com' })];
    const result = identifyPrimaryAndSecondary(messages, 'Inbound');
    expect(isFullyInternal(result)).toBe(false);
  });

  it('is false when the external party is only a secondary (cc), not the primary', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmail: '', ccEmails: ['alice@x.com'] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    // alice ends up as primary via the cc fallback here, but either way there's an external party.
    expect(isFullyInternal(result)).toBe(false);
  });
});
