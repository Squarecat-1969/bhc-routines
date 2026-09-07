import { describe, expect, it } from 'vitest';

import {
  isOwnedAddress,
  parseAddressList,
  parseCcList,
  parseRawEmailsJson,
  stripOwned,
} from '../../src/passes/pass2/parse-emails.js';

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

describe('parseAddressList', () => {
  it('splits the real comma-joined value that broke row 356', () => {
    // ⚠ THE LIVE DEFECT, verbatim from Brain_Complete row 356. Read as one
    // string this matched nothing anywhere, even though Chris Martin has been
    // bridged as BHC-00715 since 2026-04-13.
    expect(parseAddressList('chris.martin@dcsg.com,rachel.norris@dcsg.com')).toEqual([
      'chris.martin@dcsg.com',
      'rachel.norris@dcsg.com',
    ]);
  });

  it('splits the three-address value from row 261', () => {
    expect(parseAddressList('jhughes@hmlglaw.com,sholmes@hmlglaw.com,sevrin@thenewblank.com')).toEqual([
      'jhughes@hmlglaw.com',
      'sholmes@hmlglaw.com',
      'sevrin@thenewblank.com',
    ]);
  });

  it('leaves a single plain address completely unchanged', () => {
    // ⚠ THE OTHER HALF OF THE MUTATION. 74 of the 128 live recipient_email
    // values hold exactly one address; a splitter that disturbed them would
    // trade one broken case for seventy-four.
    expect(parseAddressList('alice@example.com')).toEqual(['alice@example.com']);
  });

  it('trims surrounding whitespace and lowercases, as the old scalar path did', () => {
    expect(parseAddressList(' Chris.Martin@DCSG.com , rachel.norris@dcsg.com ')).toEqual([
      'chris.martin@dcsg.com',
      'rachel.norris@dcsg.com',
    ]);
  });

  it('returns [] for empty or separator-only input rather than an empty address', () => {
    // A '' entry would look like a real participant to everything downstream.
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
    expect(parseAddressList(',,')).toEqual([]);
    expect(parseAddressList('a@x.com,,b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('does NOT split on a semicolon, because no live value contains one', () => {
    // ⚠ DELIBERATE, NOT AN OVERSIGHT. Measured 2026-09-07: zero semicolons and
    // zero display-name forms across all 516 messages. This test pins the
    // narrowness so that widening it is a decision someone makes on evidence,
    // rather than something that drifts in. If real data ever carries a
    // semicolon, change parseAddressList and change this test with it.
    expect(parseAddressList('a@x.com;b@y.com')).toEqual(['a@x.com;b@y.com']);
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

  it('splits a multi-address recipient_email into separate addresses', () => {
    const raw = JSON.stringify([
      {
        email_msg_id: 'm1',
        direction: 'Outbound',
        sender_email: 'Bobby@thenewblank.com',
        recipient_email: 'Chris.Martin@dcsg.com,Rachel.Norris@dcsg.com',
        cc_list: '',
      },
    ]);
    expect(parseRawEmailsJson(raw)[0]!.recipientEmails).toEqual([
      'chris.martin@dcsg.com',
      'rachel.norris@dcsg.com',
    ]);
  });

  it('gives a blank recipient_email an empty list, not a list holding ""', () => {
    expect(parseRawEmailsJson(sample)[0]!.recipientEmails).toEqual([]);
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
