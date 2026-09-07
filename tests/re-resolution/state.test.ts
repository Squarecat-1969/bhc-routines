/**
 * The retry gate. ⚠ THIS IS THE WHOLE DESIGN — get it wrong and the pass is a
 * nightly 264-call no-op that reports success.
 *
 * Measured 2026-09-07: of 347 blank rows, 289 cannot resolve tonight by any
 * mechanism this pass controls (83 with no derivable external party, 206 with
 * no Attio record). Re-judging them every run buys nothing.
 */

import { describe, expect, it } from 'vitest';

import { DERIVATION_VERSION, STATE_COLS, STATE_COLUMNS } from '../../src/passes/re-resolution/constants.js';
import {
  corpusFingerprint,
  isTerminalClass,
  parseStateRow,
  serializeStateRow,
  shouldAttempt,
  type RowState,
} from '../../src/passes/re-resolution/state.js';

const FP = corpusFingerprint({ contactsEmailCount: 100, bridgedAttioCount: 2255 });

function state(over: Partial<RowState> = {}): RowState {
  return {
    threadId: 't1', brainCompleteRow: 101, lastClass: 'NEW_CANDIDATE', terminal: false,
    derivationVersion: DERIVATION_VERSION, corpusFingerprint: FP,
    lastAttemptDate: '2026-09-07', notes: '', cells: [], ...over,
  };
}

describe('the corpus fingerprint', () => {
  it('changes when a contact is bridged in Attio', () => {
    // A NEW_CANDIDATE row resolves only after someone mints or bridges its
    // contact, and either act moves this number. That is the signal.
    expect(corpusFingerprint({ contactsEmailCount: 100, bridgedAttioCount: 2255 }))
      .not.toBe(corpusFingerprint({ contactsEmailCount: 100, bridgedAttioCount: 2256 }));
  });

  it('changes when the Contacts email map grows', () => {
    expect(corpusFingerprint({ contactsEmailCount: 100, bridgedAttioCount: 2255 }))
      .not.toBe(corpusFingerprint({ contactsEmailCount: 101, bridgedAttioCount: 2255 }));
  });

  it('is stable when nothing has changed', () => {
    expect(corpusFingerprint({ contactsEmailCount: 100, bridgedAttioCount: 2255 })).toBe(FP);
  });
});

describe('shouldAttempt — ⚠ BOTH DIRECTIONS', () => {
  it('attempts a row it has never seen', () => {
    expect(shouldAttempt(undefined, FP)).toEqual({ attempt: true, reason: 'never-attempted' });
  });

  // ⚠⚠ DIRECTION 1: A FINGERPRINT CHANGE MUST RE-OPEN A ROW.
  it('RE-OPENS a row when the corpus has moved', () => {
    // Joleen Hughes's row sat unresolved for five weeks while her contact was
    // bridged. This is the check that catches that the day it happens.
    const moved = corpusFingerprint({ contactsEmailCount: 100, bridgedAttioCount: 2256 });
    expect(shouldAttempt(state(), moved)).toEqual({ attempt: true, reason: 'corpus-moved' });
  });

  // ⚠⚠ DIRECTION 2: AN UNCHANGED CORPUS MUST NOT.
  it('does NOT re-attempt when nothing could have changed', () => {
    // 289 of 347 rows are in this state on any given night. Attempting them is
    // spend with no progress, reported green.
    expect(shouldAttempt(state(), FP)).toEqual({ attempt: false, reason: 'corpus-unchanged' });
  });

  it('does NOT re-attempt a terminal row on an unchanged corpus', () => {
    expect(shouldAttempt(state({ terminal: true, lastClass: 'NO_PRIMARY_EMAIL' }), FP))
      .toEqual({ attempt: false, reason: 'terminal' });
  });

  it('does NOT re-attempt a terminal row even when the corpus HAS moved', () => {
    // There is no email to resolve; bridging a thousand contacts changes
    // nothing about a thread with no external party.
    const moved = corpusFingerprint({ contactsEmailCount: 999, bridgedAttioCount: 9999 });
    expect(shouldAttempt(state({ terminal: true }), moved)).toEqual({ attempt: false, reason: 'terminal' });
  });
});

describe('the derivation version — a marker is a conclusion, not a fact', () => {
  // ⚠ The primary-email derivation CHANGED on 2026-09-07 (the stripOwned fix
  // in participants.ts). A terminal marker set by the older derivation is not
  // evidence about the newer one.
  it('RE-OPENS a terminal row when the derivation version has moved', () => {
    expect(shouldAttempt(state({ terminal: true, derivationVersion: '2026-08-01' }), FP))
      .toEqual({ attempt: true, reason: 'derivation-changed' });
  });

  it('re-opens even when the corpus is unchanged — the version alone is enough', () => {
    const d = shouldAttempt(state({ terminal: false, derivationVersion: '2026-08-01' }), FP);
    expect(d.attempt).toBe(true);
    expect(d.reason).toBe('derivation-changed');
  });

  it('⚠ checks the version BEFORE honouring terminal, not after', () => {
    // Order matters: terminal-first would keep 83 rows closed forever under a
    // derivation that never judged them, with no manual clearing step anyone
    // would remember to run.
    const old = state({ terminal: true, derivationVersion: 'ancient' });
    expect(shouldAttempt(old, FP).attempt).toBe(true);
  });
});

describe('terminal marking', () => {
  it('marks ONLY the structurally-unresolvable class', () => {
    expect(isTerminalClass('NO_PRIMARY_EMAIL')).toBe(true);
    // These can all resolve later — a mint, a bridge, a disambiguation.
    expect(isTerminalClass('NEW_CANDIDATE')).toBe(false);
    expect(isTerminalClass('UNRESOLVED')).toBe(false);
    expect(isTerminalClass('RESOLVABLE')).toBe(false);
  });

  it('stamps the derivation version onto every row it writes', () => {
    const cells = serializeStateRow({
      threadId: 't1', brainCompleteRow: 101, cls: 'NO_PRIMARY_EMAIL',
      fingerprint: FP, today: '2026-09-07', notes: 'n',
    });
    expect(cells).toHaveLength(STATE_COLUMNS);
    expect(cells[STATE_COLS.terminal]).toBe('TRUE');
    expect(cells[STATE_COLS.derivationVersion]).toBe(DERIVATION_VERSION);
    expect(cells[STATE_COLS.corpusFingerprint]).toBe(FP);
  });

  it('does not mark a NEW_CANDIDATE terminal', () => {
    const cells = serializeStateRow({
      threadId: 't1', brainCompleteRow: 101, cls: 'NEW_CANDIDATE',
      fingerprint: FP, today: '2026-09-07', notes: '',
    });
    expect(cells[STATE_COLS.terminal]).toBe('FALSE');
  });

  it('round-trips through parseStateRow', () => {
    const cells = serializeStateRow({
      threadId: 't9', brainCompleteRow: 42, cls: 'NO_PRIMARY_EMAIL',
      fingerprint: FP, today: '2026-09-07', notes: 'x',
    });
    const parsed = parseStateRow(cells as string[])!;
    expect(parsed.threadId).toBe('t9');
    expect(parsed.brainCompleteRow).toBe(42);
    expect(parsed.terminal).toBe(true);
    expect(parsed.derivationVersion).toBe(DERIVATION_VERSION);
    // And the round-tripped row is honoured by the gate.
    expect(shouldAttempt(parsed, FP)).toEqual({ attempt: false, reason: 'terminal' });
  });

  it('treats a blank thread_id row as padding, not data', () => {
    expect(parseStateRow(['', '', '', '', '', '', '', ''])).toBeNull();
  });
});
