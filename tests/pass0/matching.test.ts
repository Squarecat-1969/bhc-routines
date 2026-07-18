import { describe, expect, it } from 'vitest';

import {
  findOpenPlaceholders,
  findOutboundCandidates,
  isStalePlaceholder,
  matchPlaceholder,
  parseTimestampMs,
} from '../../src/passes/pass0/matching.js';
import type { Placeholder } from '../../src/passes/pass0/types.js';
import type { ThreadStagingRow } from '../../src/passes/pass1/types.js';

function activityLogRow(opts: {
  activityId: string;
  body?: string;
  nextActionNote?: string;
  contactId?: string;
  contactName?: string;
  timestamp?: string;
}): unknown[] {
  const row = new Array<unknown>(21).fill('');
  row[0] = opts.activityId;
  row[1] = opts.timestamp ?? '2026-07-15T12:00:00Z';
  row[2] = opts.contactId ?? 'BHC-00001';
  row[4] = opts.contactName ?? 'Alice Nguyen';
  row[9] = opts.body ?? '';
  row[15] = opts.nextActionNote ?? '';
  return row;
}

function candidate(opts: Partial<ThreadStagingRow> & { threadId: string }): ThreadStagingRow {
  return {
    threadId: opts.threadId,
    bhcId: opts.bhcId ?? '',
    contactName: opts.contactName ?? 'Alice Nguyen',
    sourceMailbox: opts.sourceMailbox ?? '',
    direction: opts.direction ?? 'Outbound',
    subject: opts.subject ?? 'Re: catching up',
    firstEmailDate: opts.firstEmailDate ?? '',
    lastEmailDate: opts.lastEmailDate ?? '2026-07-15T12:30:00Z',
    emailCount: opts.emailCount ?? '1',
    rawEmailsJson: opts.rawEmailsJson ?? '',
    rowStatus: opts.rowStatus ?? 'ACTIVE',
    runId: opts.runId ?? '',
    sheetRow: opts.sheetRow ?? 2,
  };
}

describe('findOpenPlaceholders', () => {
  it('finds a placeholder by body prefix', () => {
    const rows = [activityLogRow({ activityId: 'ACT-1', body: '[PENDING_CAPTURE] draft' })];
    const found = findOpenPlaceholders(rows);
    expect(found).toHaveLength(1);
    expect(found[0]!.activityId).toBe('ACT-1');
  });

  it('finds a placeholder by next-action-note pattern and extracts the Thread_ID', () => {
    const rows = [activityLogRow({ activityId: 'ACT-2', nextActionNote: 'PENDING_CAPTURE thread:T-123' })];
    const found = findOpenPlaceholders(rows);
    expect(found).toHaveLength(1);
    expect(found[0]!.threadIdFromNote).toBe('T-123');
  });

  it('ignores rows with neither signal', () => {
    const rows = [activityLogRow({ activityId: 'ACT-3', body: 'a normal note' })];
    expect(findOpenPlaceholders(rows)).toHaveLength(0);
  });

  it('skips blank trailing rows (no Activity_ID)', () => {
    const rows = [activityLogRow({ activityId: '', body: '[PENDING_CAPTURE]' })];
    expect(findOpenPlaceholders(rows)).toHaveLength(0);
  });

  it('assigns the correct physical sheet row (data starts at row 2)', () => {
    const rows = [
      activityLogRow({ activityId: 'ACT-1', body: '[PENDING_CAPTURE]' }),
      activityLogRow({ activityId: 'ACT-2', body: '[PENDING_CAPTURE]' }),
    ];
    const found = findOpenPlaceholders(rows);
    expect(found[0]!.sheetRow).toBe(2);
    expect(found[1]!.sheetRow).toBe(3);
  });
});

describe('findOutboundCandidates', () => {
  it('keeps only Direction=Outbound rows', () => {
    const workingSet: ThreadStagingRow[] = [
      { ...candidate({ threadId: 'T1' }), direction: 'Outbound' },
      { ...candidate({ threadId: 'T2' }), direction: 'Inbound' },
    ];
    expect(findOutboundCandidates(workingSet).map((r) => r.threadId)).toEqual(['T1']);
  });
});

describe('parseTimestampMs', () => {
  it('parses ISO 8601', () => {
    expect(parseTimestampMs('2026-07-15T12:00:00Z')).not.toBeNull();
  });

  it('returns null for empty or garbage input, rather than guessing', () => {
    expect(parseTimestampMs('')).toBeNull();
    expect(parseTimestampMs('not a date')).toBeNull();
  });
});

describe('matchPlaceholder', () => {
  const basePlaceholder: Placeholder = {
    activityId: 'ACT-1',
    contactId: 'BHC-00001',
    contactName: 'Alice Nguyen',
    timestamp: '2026-07-15T12:00:00Z',
    threadIdFromNote: '',
    sheetRow: 2,
  };

  it('EXACT: matches by Thread_ID when present, regardless of name/time', () => {
    const placeholder = { ...basePlaceholder, threadIdFromNote: 'T-999' };
    const candidates = [candidate({ threadId: 'T-999', contactName: 'Someone Else', lastEmailDate: '2020-01-01' })];
    const result = matchPlaceholder(placeholder, candidates);
    expect(result.verdict).toBe('EXACT');
    expect(result.candidate?.threadId).toBe('T-999');
  });

  it('falls through to contact+72h when Thread_ID is present but not found among candidates', () => {
    const placeholder = { ...basePlaceholder, threadIdFromNote: 'T-MISSING' };
    const candidates = [candidate({ threadId: 'T-OTHER', contactName: 'Alice Nguyen', lastEmailDate: '2026-07-15T13:00:00Z' })];
    const result = matchPlaceholder(placeholder, candidates);
    expect(result.verdict).toBe('INFERRED');
  });

  it('INFERRED: matches by shared significant name word within 72h', () => {
    const candidates = [candidate({ threadId: 'T1', contactName: 'Alice Nguyen-Smith', lastEmailDate: '2026-07-15T13:00:00Z' })];
    const result = matchPlaceholder(basePlaceholder, candidates);
    expect(result.verdict).toBe('INFERRED');
    expect(result.candidate?.threadId).toBe('T1');
  });

  it('NO_MATCH: same name but outside the 72h window', () => {
    const candidates = [candidate({ threadId: 'T1', contactName: 'Alice Nguyen', lastEmailDate: '2026-07-01T12:00:00Z' })];
    const result = matchPlaceholder(basePlaceholder, candidates);
    expect(result.verdict).toBe('NO_MATCH');
  });

  it('NO_MATCH: within window but zero shared significant name words', () => {
    const candidates = [candidate({ threadId: 'T1', contactName: 'Robert Chen', lastEmailDate: '2026-07-15T13:00:00Z' })];
    const result = matchPlaceholder(basePlaceholder, candidates);
    expect(result.verdict).toBe('NO_MATCH');
  });

  it('AMBIGUOUS: more than one candidate matches contact+72h', () => {
    const candidates = [
      candidate({ threadId: 'T1', contactName: 'Alice Nguyen', lastEmailDate: '2026-07-15T13:00:00Z' }),
      candidate({ threadId: 'T2', contactName: 'Alice Nguyen', lastEmailDate: '2026-07-15T14:00:00Z' }),
    ];
    const result = matchPlaceholder(basePlaceholder, candidates);
    expect(result.verdict).toBe('AMBIGUOUS');
    expect(result.ambiguousCandidates).toHaveLength(2);
  });

  it('NO_MATCH (not a crash) when the placeholder timestamp is unparseable', () => {
    const placeholder = { ...basePlaceholder, timestamp: 'garbage' };
    const candidates = [candidate({ threadId: 'T1', contactName: 'Alice Nguyen', lastEmailDate: '2026-07-15T13:00:00Z' })];
    const result = matchPlaceholder(placeholder, candidates);
    expect(result.verdict).toBe('NO_MATCH');
  });
});

describe('isStalePlaceholder', () => {
  const NOW = new Date('2026-07-18T00:00:00Z').getTime();

  it('is true after 7 days', () => {
    const placeholder: Placeholder = {
      activityId: 'ACT-1', contactId: '', contactName: '', threadIdFromNote: '', sheetRow: 2,
      timestamp: '2026-07-01T00:00:00Z',
    };
    expect(isStalePlaceholder(placeholder, NOW)).toBe(true);
  });

  it('is false within 7 days', () => {
    const placeholder: Placeholder = {
      activityId: 'ACT-1', contactId: '', contactName: '', threadIdFromNote: '', sheetRow: 2,
      timestamp: '2026-07-16T00:00:00Z',
    };
    expect(isStalePlaceholder(placeholder, NOW)).toBe(false);
  });

  it('is false (not a guess) when the timestamp is unparseable', () => {
    const placeholder: Placeholder = {
      activityId: 'ACT-1', contactId: '', contactName: '', threadIdFromNote: '', sheetRow: 2,
      timestamp: 'garbage',
    };
    expect(isStalePlaceholder(placeholder, NOW)).toBe(false);
  });
});
