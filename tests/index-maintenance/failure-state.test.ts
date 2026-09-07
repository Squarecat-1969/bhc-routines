/**
 * The blocking gate.
 *
 * ⚠ THE REAL CASE: §092 and §096 failed three consecutive runs, §102 two, all
 * with `terms: Array must contain at most 12 element(s)` — because nothing
 * told the model there was a cap. Each retried at full cost every run while
 * the run reported green.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOCK_AFTER,
  PROMPT_VERSION,
  STATE_COLS,
  STATE_COLUMNS,
  blockDecision,
  nextState,
  parseFailureRow,
  serializeFailureRow,
  type EntryFailureState,
} from '../../src/passes/index-maintenance/failure-state.js';

const VOCAB = 155;
const CAP_ERROR = 'terms: Array must contain at most 12 element(s)';

function st(over: Partial<EntryFailureState> = {}): EntryFailureState {
  return {
    locator: '§092', consecutiveFailures: 3, blocked: true, lastError: CAP_ERROR,
    lastAttemptDate: '2026-09-07', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB, ...over,
  };
}

describe('the threshold', () => {
  it('is three', () => {
    expect(BLOCK_AFTER).toBe(3);
  });

  it('does NOT block on one or two failures — those can still be transient', () => {
    // A 429, a timeout, a truncated response. Blocking a run too early costs
    // an entry that would have indexed and is now silently absent.
    let s = nextState({ locator: '§092', prior: undefined, succeeded: false, error: CAP_ERROR, today: 'd', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB });
    expect(s.consecutiveFailures).toBe(1);
    expect(s.blocked).toBe(false);
    s = nextState({ locator: '§092', prior: s, succeeded: false, error: CAP_ERROR, today: 'd', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB });
    expect(s.consecutiveFailures).toBe(2);
    expect(s.blocked).toBe(false);
  });

  it('blocks on the THIRD consecutive failure', () => {
    let s = nextState({ locator: '§092', prior: undefined, succeeded: false, error: CAP_ERROR, today: 'd', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB });
    s = nextState({ locator: '§092', prior: s, succeeded: false, error: CAP_ERROR, today: 'd', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB });
    s = nextState({ locator: '§092', prior: s, succeeded: false, error: CAP_ERROR, today: 'd', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB });
    expect(s.consecutiveFailures).toBe(3);
    expect(s.blocked).toBe(true);
    expect(s.lastError).toBe(CAP_ERROR);
  });

  it('CONSECUTIVE, not cumulative — a success resets the count', () => {
    // An entry that failed twice and then indexed is not two-thirds blocked.
    const failedTwice = st({ consecutiveFailures: 2, blocked: false });
    const s = nextState({ locator: '§092', prior: failedTwice, succeeded: true, error: null, today: 'd', promptVersion: PROMPT_VERSION, vocabularySize: VOCAB });
    expect(s.consecutiveFailures).toBe(0);
    expect(s.blocked).toBe(false);
    expect(s.lastError).toBe('');
  });
});

describe('blockDecision — the gate', () => {
  it('does not block an entry it has never seen', () => {
    expect(blockDecision(undefined, PROMPT_VERSION, VOCAB)).toEqual({ blocked: false, reason: 'no-state' });
  });

  it('BLOCKS a blocked entry, carrying its count and last error for the report', () => {
    expect(blockDecision(st(), PROMPT_VERSION, VOCAB)).toEqual({
      blocked: true, failures: 3, lastError: CAP_ERROR,
    });
  });

  it('does not block an entry below the threshold', () => {
    expect(blockDecision(st({ consecutiveFailures: 2, blocked: false }), PROMPT_VERSION, VOCAB))
      .toEqual({ blocked: false, reason: 'not-yet' });
  });

  // ⚠⚠ A BLOCK IS A CONCLUSION FROM A VERSION OF THE PROMPT, NOT A FACT.
  it('RE-OPENS a blocked entry when the prompt version changes', () => {
    // §092, §096 and §102 were blocked because nothing told the model about
    // the cap. Under the prompt that does, all three index. Without this they
    // would stay blocked forever under a prompt that never judged them.
    expect(blockDecision(st({ promptVersion: 'older-prompt' }), PROMPT_VERSION, VOCAB))
      .toEqual({ blocked: false, reason: 'prompt-changed' });
  });

  it('RE-OPENS a blocked entry when the vocabulary has grown', () => {
    // A new term is a genuine reason the outcome could differ.
    expect(blockDecision(st(), PROMPT_VERSION, VOCAB + 1))
      .toEqual({ blocked: false, reason: 'vocabulary-changed' });
  });

  it('checks BOTH reset conditions before honouring the block', () => {
    expect(blockDecision(st({ promptVersion: 'old' }), PROMPT_VERSION, VOCAB).blocked).toBe(false);
    expect(blockDecision(st(), PROMPT_VERSION, 999).blocked).toBe(false);
  });

  it('a prompt change resets the count, not just the block', () => {
    // Otherwise the entry blocks again after ONE failure under the new prompt.
    const s = nextState({
      locator: '§092', prior: st({ consecutiveFailures: 3, promptVersion: 'old' }),
      succeeded: false, error: 'something else', today: 'd',
      promptVersion: PROMPT_VERSION, vocabularySize: VOCAB,
    });
    expect(s.consecutiveFailures).toBe(1);
    expect(s.blocked).toBe(false);
  });
});

describe('serialisation', () => {
  it('round-trips, and the round-tripped row is honoured by the gate', () => {
    const cells = serializeFailureRow(st());
    expect(cells).toHaveLength(STATE_COLUMNS);
    expect(cells[STATE_COLS.blocked]).toBe('TRUE');
    expect(cells[STATE_COLS.consecutiveFailures]).toBe(3);
    const back = parseFailureRow(cells as string[])!;
    expect(back.locator).toBe('§092');
    expect(blockDecision(back, PROMPT_VERSION, VOCAB).blocked).toBe(true);
  });

  it('keeps the last error so the report can name it', () => {
    const back = parseFailureRow(serializeFailureRow(st()) as string[])!;
    expect(back.lastError).toBe(CAP_ERROR);
  });

  it('treats a blank locator row as padding', () => {
    expect(parseFailureRow(['', '', '', '', '', '', ''])).toBeNull();
  });
});
