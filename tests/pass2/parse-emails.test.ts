import { describe, expect, it } from 'vitest';

import { isOwnedAddress, parseCcList, parseRawEmailsJson, stripOwned } from '../../src/passes/pass2/parse-emails.js';

describe('parseCcList', () => {
  it('extracts addresses from the real observed shape (Python-dict-repr, not JSON)', () => {
    const raw = "emailAddress: {'address': 'bobby@thenewblank.com', 'name': 'Bobby Hougham'}";
    expect(parseCcList(raw)).toEqual(['bobby@thenewblank.com']);
  });

  it('extracts multiple newline-joined entries', () => {
    const raw =
      "emailAddress: {'address': 'a@x.com', 'name': 'A'}\n\nemailAddress: {'address': 'b@y.com', 'name': 'B'}";
    expect(parseCcList(raw)).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns [] for an empty string', () => {
    expect(parseCcList('')).toEqual([]);
    expect(parseCcList('   ')).toEqual([]);
  });

  it('falls back to real JSON if a row happens to have that shape', () => {
    expect(parseCcList('["a@x.com", "b@y.com"]')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('does not crash on garbage input', () => {
    expect(parseCcList('not an address list at all')).toEqual([]);
  });
});

describe('parseRawEmailsJson', () => {
  const sample = JSON.stringify([
    {
      record_id: 'r1',
      email_msg_id: 'msg-1',
      received_at: '2026-05-14T12:04:50.000Z',
      source_mailbox: 'gmail',
      direction: 'Inbound',
      sender_name: 'Chuck Granade',
      sender_email: 'Chuck@ThenewBlank.com',
      recipient_name: '',
      recipient_email: '',
      cc_list: "emailAddress: {'address': 'bobby@thenewblank.com', 'name': 'Bobby Hougham'}",
      subject: 'Re: Long overdue',
      body: 'hello',
      thread_id: 'T1',
    },
    {
      record_id: 'r2',
      email_msg_id: 'msg-1', // duplicate — should be deduped
      received_at: '2026-05-14T12:04:50.000Z',
      source_mailbox: 'gmail',
      direction: 'Inbound',
      sender_name: 'dup',
      sender_email: 'dup@x.com',
      recipient_name: '',
      recipient_email: '',
      cc_list: '',
      subject: 'dup',
      body: 'dup',
      thread_id: 'T1',
    },
  ]);

  it('parses messages and dedupes by email_msg_id', () => {
    const messages = parseRawEmailsJson(sample);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.emailMsgId).toBe('msg-1');
  });

  it('lowercases email addresses', () => {
    const messages = parseRawEmailsJson(sample);
    expect(messages[0]!.senderEmail).toBe('chuck@thenewblank.com');
  });

  it('returns [] for malformed JSON rather than throwing', () => {
    expect(parseRawEmailsJson('not json')).toEqual([]);
    expect(parseRawEmailsJson('{}')).toEqual([]); // valid JSON but not an array
  });

  it('skips items with no email_msg_id', () => {
    const raw = JSON.stringify([{ sender_email: 'a@x.com' }]);
    expect(parseRawEmailsJson(raw)).toEqual([]);
  });
});

describe('isOwnedAddress / stripOwned', () => {
  it('matches the spec-listed exact addresses', () => {
    expect(isOwnedAddress('bobby@hougham.us')).toBe(true);
    expect(isOwnedAddress('bobbyhougham@gmail.com')).toBe(true);
    expect(isOwnedAddress('bobby@thenewblank.com')).toBe(true);
  });

  it('matches any address at an owned domain (internal TNB staff)', () => {
    expect(isOwnedAddress('chuck@thenewblank.com')).toBe(true);
    expect(isOwnedAddress('sevrin@thenewblank.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isOwnedAddress('Bobby@TheNewBlank.com')).toBe(true);
  });

  it('does not match an external address', () => {
    expect(isOwnedAddress('someone@example.com')).toBe(false);
  });

  it('stripOwned removes only owned addresses, preserves order', () => {
    expect(stripOwned(['bobby@thenewblank.com', 'a@x.com', 'chuck@thenewblank.com', 'b@y.com'])).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });
});
