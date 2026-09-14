/**
 * THE MEASUREMENTS the email contract is built from. Live Attio, 2026-09-13.
 *
 * Sequence 1 ran on scratch person 3a7070bf-139d-4c82-bd36-c6cfc8fc98cb;
 * sequence 2 on two scratch persons, "ZZ Scratch I1Unique X/Y". All three were
 * deleted afterwards (re-GET 404), as were the `example.com` company records
 * Attio auto-created for them.
 *
 * Letters stand for distinct addresses. `B_UPPER` is address B in capitals.
 * `expect` is the stored list read back after the step. THESE ARE OBSERVED
 * RESULTS — edit them only after re-measuring, never to make a test pass.
 */

export type ContractOp = 'patch' | 'put';

export interface ContractStep {
  readonly label: string;
  readonly op: ContractOp;
  readonly send: readonly string[];
  readonly expect: readonly string[];
}

export const MEASURED_ONE_RECORD: {
  readonly measuredOn: string;
  readonly initial: readonly string[];
  readonly steps: readonly ContractStep[];
} = {
  measuredOn: '2026-09-13',
  initial: ['A'],
  steps: [
    { label: "PATCH [B, A] — I1's old first write", op: 'patch', send: ['B', 'A'], expect: ['B', 'A'] },
    { label: 'PATCH [B, A] again — the retry: no duplicate', op: 'patch', send: ['B', 'A'], expect: ['B', 'A'] },
    { label: 'PATCH [A] — never removes, never moves', op: 'patch', send: ['A'], expect: ['B', 'A'] },
    { label: 'PATCH [B in capitals] — repeat matched case-insensitively', op: 'patch', send: ['B_UPPER'], expect: ['B', 'A'] },
    { label: 'PUT [B] — overwrites', op: 'put', send: ['B'], expect: ['B'] },
    { label: 'PUT [A, B] — order honoured', op: 'put', send: ['A', 'B'], expect: ['A', 'B'] },
    { label: 'PUT [B, A] — order honoured, reversed', op: 'put', send: ['B', 'A'], expect: ['B', 'A'] },
  ],
};

/** Record X holds A, record Y holds C; Y then tries to take A. */
export const MEASURED_CONFLICT: {
  readonly measuredOn: string;
  readonly x: readonly string[];
  readonly y: readonly string[];
  readonly attempts: readonly { readonly op: ContractOp; readonly sendToY: readonly string[] }[];
  readonly expectStatus: 400;
  readonly expectCode: 'uniqueness_conflict';
  readonly expectX: readonly string[];
  readonly expectY: readonly string[];
} = {
  measuredOn: '2026-09-13',
  x: ['A'],
  y: ['C'],
  attempts: [
    { op: 'patch', sendToY: ['A', 'C'] },
    { op: 'put', sendToY: ['A', 'C'] },
  ],
  expectStatus: 400,
  expectCode: 'uniqueness_conflict',
  expectX: ['A'],
  expectY: ['C'],
};

/** Letter -> a concrete address, so fixtures stay readable. */
export function addr(letter: string): string {
  if (letter === 'B_UPPER') return 'B@EXAMPLE.TEST';
  return `${letter.toLowerCase()}@example.test`;
}
export function letters(emails: readonly string[]): string[] {
  return emails.map((e) => e.split('@')[0]!.toUpperCase());
}
