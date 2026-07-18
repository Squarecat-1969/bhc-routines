import { describe, expect, it } from 'vitest';

import { triageContent } from '../../src/passes/pass2/triage.js';
import type { RawEmailMessage } from '../../src/passes/pass2/types.js';

function msg(opts: Partial<RawEmailMessage>): RawEmailMessage {
  return {
    recordId: '', emailMsgId: '1', receivedAt: '', sourceMailbox: '', direction: 'Inbound',
    senderName: '', senderEmail: '', recipientName: '', recipientEmail: '', ccEmails: [],
    subject: '', body: '', threadId: '',
    ...opts,
  };
}

describe('triageContent', () => {
  it('flags an automated no-reply sender', () => {
    const result = triageContent([msg({ senderEmail: 'no-reply@service.com', subject: 'Your receipt' })]);
    expect(result.isNoise).toBe(true);
    expect(result.tag).toBe('noise:automated');
  });

  it('flags a vendor support sender', () => {
    const result = triageContent([msg({ senderEmail: 'billing@vendor.com' })]);
    expect(result.isNoise).toBe(true);
    expect(result.tag).toBe('vendor');
  });

  it('flags a cold-outreach subject', () => {
    const result = triageContent([msg({ subject: 'quick question about your team' })]);
    expect(result.isNoise).toBe(true);
    expect(result.tag).toBe('noise:cold');
  });

  it('flags sensitive medical content', () => {
    const result = triageContent([msg({ body: 'Following up on your diagnosis and prescription refill' })]);
    expect(result.isNoise).toBe(true);
    expect(result.tag).toBe('noise:sensitive');
  });

  it('sensitive takes priority over automated when both could match', () => {
    const result = triageContent([msg({ senderEmail: 'no-reply@clinic.com', body: 'your prescription is ready' })]);
    expect(result.tag).toBe('noise:sensitive');
  });

  it('does not flag genuine relationship content — defers to enrichment', () => {
    const result = triageContent([msg({ senderEmail: 'alice@example.com', subject: 'Following up on Friday', body: 'Great catching up!' })]);
    expect(result.isNoise).toBe(false);
    expect(result.tag).toBeNull();
  });

  it('handles an empty message list without crashing', () => {
    const result = triageContent([]);
    expect(result.isNoise).toBe(false);
  });
});
