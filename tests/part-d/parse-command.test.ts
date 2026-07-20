import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/part-d/parse-command.js';

describe('parseCommand — basic commands', () => {
  it('parses RESOLVE with a run ID', () => {
    const result = parseCommand('RESOLVE LATE-EDITION-1784499863693');
    expect(result).toEqual({ kind: 'RESOLVE', runId: 'LATE-EDITION-1784499863693' });
  });

  it('parses PROCEED with a run ID', () => {
    const result = parseCommand('PROCEED LATE-EDITION-123');
    expect(result).toEqual({ kind: 'PROCEED', runId: 'LATE-EDITION-123' });
  });

  it('is case-insensitive on the command token', () => {
    expect(parseCommand('resolve LATE-EDITION-123').kind).toBe('RESOLVE');
    expect(parseCommand('Proceed LATE-EDITION-123').kind).toBe('PROCEED');
  });

  it('returns NO_RUN_ID when no LATE-EDITION-<digits> token is present', () => {
    expect(parseCommand('RESOLVE')).toEqual({ kind: 'NO_RUN_ID' });
    expect(parseCommand('')).toEqual({ kind: 'NO_RUN_ID' });
  });

  it('returns UNRECOGNIZED for an unknown command token, even with a valid run ID', () => {
    expect(parseCommand('DELETE LATE-EDITION-123')).toEqual({ kind: 'UNRECOGNIZED' });
  });
});

describe('parseCommand — CORRECTIONS', () => {
  it('parses {n}: {note} lines', () => {
    const result = parseCommand('CORRECTIONS LATE-EDITION-123\n3: wrong contact\n7: already handled elsewhere');
    expect(result.kind).toBe('CORRECTIONS');
    if (result.kind !== 'CORRECTIONS') throw new Error('unreachable');
    expect(result.corrections).toEqual([
      { n: 3, note: 'wrong contact' },
      { n: 7, note: 'already handled elsewhere' },
    ]);
  });

  it('skips a line with no note rather than defaulting to an empty note', () => {
    const result = parseCommand('CORRECTIONS LATE-EDITION-123\n3:\n7: real note');
    expect(result.kind).toBe('CORRECTIONS');
    if (result.kind !== 'CORRECTIONS') throw new Error('unreachable');
    expect(result.corrections).toEqual([{ n: 7, note: 'real note' }]);
  });

  it('returns an empty corrections list (not an error) when there are no valid lines', () => {
    const result = parseCommand('CORRECTIONS LATE-EDITION-123');
    expect(result.kind).toBe('CORRECTIONS');
    if (result.kind !== 'CORRECTIONS') throw new Error('unreachable');
    expect(result.corrections).toEqual([]);
  });
});

describe('parseCommand — MIXED (session addition, not in the original spec)', () => {
  it('parses ACCEPT and DISMISS lines', () => {
    const result = parseCommand('MIXED LATE-EDITION-123\n1:ACCEPT\n4:DISMISS');
    expect(result.kind).toBe('MIXED');
    if (result.kind !== 'MIXED') throw new Error('unreachable');
    expect(result.itemActions).toEqual([
      { n: 1, action: 'ACCEPT' },
      { n: 4, action: 'DISMISS' },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('parses CORRECT lines with a note', () => {
    const result = parseCommand('MIXED LATE-EDITION-123\n2:CORRECT:wrong company name');
    if (result.kind !== 'MIXED') throw new Error('unreachable');
    expect(result.itemActions).toEqual([{ n: 2, action: 'CORRECT', note: 'wrong company name' }]);
  });

  it('skips a CORRECT line with no note — a correction with no explanation is not a correction', () => {
    const result = parseCommand('MIXED LATE-EDITION-123\n2:CORRECT:\n3:ACCEPT');
    if (result.kind !== 'MIXED') throw new Error('unreachable');
    expect(result.itemActions).toEqual([{ n: 3, action: 'ACCEPT' }]);
    expect(result.skipped).toEqual(['2:CORRECT:']);
  });

  it('skips an unrecognized action verb without dropping the other valid lines', () => {
    const result = parseCommand('MIXED LATE-EDITION-123\n1:ACCEPT\n2:MAYBE\n3:DISMISS');
    if (result.kind !== 'MIXED') throw new Error('unreachable');
    expect(result.itemActions).toEqual([{ n: 1, action: 'ACCEPT' }, { n: 3, action: 'DISMISS' }]);
    expect(result.skipped).toEqual(['2:MAYBE']);
  });

  it('is case-insensitive on action verbs', () => {
    const result = parseCommand('MIXED LATE-EDITION-123\n1:accept\n2:correct:lowercase note');
    if (result.kind !== 'MIXED') throw new Error('unreachable');
    expect(result.itemActions).toEqual([{ n: 1, action: 'ACCEPT' }, { n: 2, action: 'CORRECT', note: 'lowercase note' }]);
  });

  it('returns an empty itemActions list (not an error) when every line is malformed', () => {
    const result = parseCommand('MIXED LATE-EDITION-123\ngarbage\nmore garbage');
    if (result.kind !== 'MIXED') throw new Error('unreachable');
    expect(result.itemActions).toEqual([]);
    expect(result.skipped).toEqual(['garbage', 'more garbage']);
  });
});
