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
    recipientEmails: [],
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
    const messages = [msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmails: ['alice@x.com'] })];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('alice@x.com');
  });

  it('outbound: falls back to cc when recipient_email is blank (real-data gap)', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmails: [], ccEmails: ['alice@x.com'] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('alice@x.com');
  });

  it('outbound: falls back to most-frequent external address when recipient and cc are both empty', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'alice@x.com' }),
      msg({ emailMsgId: '2', direction: 'Inbound', senderEmail: 'alice@x.com' }),
      msg({ emailMsgId: '3', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmails: [], ccEmails: [] }),
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

describe('a multi-address recipient_email — the row 356 defect', () => {
  it('picks the first EXTERNAL recipient, not the whole joined string', () => {
    // ⚠ THE LIVE ROW. Before 2026-09-07 the primary came out as the literal
    // "chris.martin@dcsg.com,rachel.norris@dcsg.com", which matched nothing in
    // the Contacts map, nothing in Attio and nothing in Master_ID — so
    // Brain_Complete row 356 got an empty Contact_ID while Chris Martin had
    // been bridged as BHC-00715 since 2026-04-13.
    const messages = [
      msg({ emailMsgId: '1', direction: 'Inbound', senderEmail: 'chris.martin@dcsg.com' }),
      msg({
        emailMsgId: '2',
        direction: 'Outbound',
        senderEmail: 'bobby@thenewblank.com',
        recipientEmails: ['chris.martin@dcsg.com', 'rachel.norris@dcsg.com'],
      }),
      msg({ emailMsgId: '3', direction: 'Inbound', senderEmail: 'chris.martin@dcsg.com' }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('chris.martin@dcsg.com');
  });

  it('keeps the OTHER address as a secondary instead of losing it', () => {
    // The secondary path was built from the same parse, so row 356 lost Rachel
    // Norris entirely — she was neither the primary nor a participant.
    const messages = [
      msg({
        emailMsgId: '1',
        direction: 'Outbound',
        senderEmail: 'bobby@thenewblank.com',
        recipientEmails: ['chris.martin@dcsg.com', 'rachel.norris@dcsg.com'],
      }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.secondaryEmails).toEqual(['rachel.norris@dcsg.com']);
  });

  it('skips an owned address inside the list and takes the client', () => {
    // ⚠ A JOINED STRING IS NEVER ITSELF AN OWNED ADDRESS, so the old code could
    // not see an internal recipient hiding in one. Per-address is the point.
    const messages = [
      msg({
        emailMsgId: '1',
        direction: 'Outbound',
        senderEmail: 'bobby@thenewblank.com',
        recipientEmails: ['sevrin@thenewblank.com', 'alice@client.com'],
      }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    expect(result.primaryEmail).toBe('alice@client.com');
    expect(result.secondaryEmails).not.toContain('sevrin@thenewblank.com');
  });

  it('does not smuggle an owned address into the participant list — row 261', () => {
    // Live value: "jhughes@hmlglaw.com,sholmes@hmlglaw.com,sevrin@thenewblank.com".
    // As one string it passed stripOwned untouched and became a "participant"
    // that was really three people, one of them internal.
    const messages = [
      msg({
        emailMsgId: '1',
        direction: 'Outbound',
        senderEmail: 'bobby@thenewblank.com',
        recipientEmails: ['jhughes@hmlglaw.com', 'sholmes@hmlglaw.com', 'sevrin@thenewblank.com'],
      }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    const everyone = [result.primaryEmail, ...result.secondaryEmails];
    expect(everyone).toEqual(['jhughes@hmlglaw.com', 'sholmes@hmlglaw.com']);
    expect(everyone.some((e) => e !== null && e.includes(','))).toBe(false);
  });

  it('still falls through to cc when EVERY recipient is owned', () => {
    // ⚠ THE PRE-EXISTING BEHAVIOUR MUST SURVIVE. This is the case the old
    // scalar check handled correctly, and the list version has to keep it.
    const messages = [
      msg({
        emailMsgId: '1',
        direction: 'Outbound',
        senderEmail: 'bobby@thenewblank.com',
        recipientEmails: ['lana@thenewblank.com', 'sevrin@thenewblank.com'],
        ccEmails: ['alice@client.com'],
      }),
    ];
    expect(identifyPrimaryAndSecondary(messages, 'Outbound').primaryEmail).toBe('alice@client.com');
  });
});

describe('isFullyInternal', () => {
  it('is true when every participant is an owned address — the real Sevrin/loan-billing case found in production', () => {
    const messages = [
      msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmails: ['sevrin@thenewblank.com'] }),
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
      msg({ emailMsgId: '1', direction: 'Outbound', senderEmail: 'bobby@thenewblank.com', recipientEmails: [], ccEmails: ['alice@x.com'] }),
    ];
    const result = identifyPrimaryAndSecondary(messages, 'Outbound');
    // alice ends up as primary via the cc fallback here, but either way there's an external party.
    expect(isFullyInternal(result)).toBe(false);
  });
});
