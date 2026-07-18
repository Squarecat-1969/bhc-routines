import { describe, expect, it } from 'vitest';

import { buildThreadStagingWorkingSet, splitBrainCompleteRows } from '../../src/passes/pass1/housekeeping.js';

function brainCompleteRow(resolved: boolean | string): unknown[] {
  const row = new Array<unknown>(30).fill('');
  row[21] = resolved; // col V
  return row;
}

function threadStagingRow(opts: { threadId: string; status: string }): unknown[] {
  const row = new Array<unknown>(23).fill('');
  row[0] = opts.threadId;
  row[21] = opts.status; // col V, Row_Status
  return row;
}

describe('splitBrainCompleteRows', () => {
  it('deletes rows where col V is boolean true', () => {
    const { survivors, resolvedCount } = splitBrainCompleteRows([
      brainCompleteRow(true),
      brainCompleteRow(false),
    ]);
    expect(resolvedCount).toBe(1);
    expect(survivors).toHaveLength(1);
  });

  it('deletes rows where col V is the string "TRUE" (case-insensitive)', () => {
    const { survivors, resolvedCount } = splitBrainCompleteRows([
      brainCompleteRow('TRUE'),
      brainCompleteRow('true'),
      brainCompleteRow('False'),
    ]);
    expect(resolvedCount).toBe(2);
    expect(survivors).toHaveLength(1);
  });

  it('treats a blank col V as a survivor, not resolved', () => {
    const { survivors, resolvedCount } = splitBrainCompleteRows([brainCompleteRow('')]);
    expect(resolvedCount).toBe(0);
    expect(survivors).toHaveLength(1);
  });

  it('preserves row order among survivors', () => {
    const rowA = brainCompleteRow(false);
    rowA[0] = 'A';
    const rowB = brainCompleteRow(true);
    rowB[0] = 'B';
    const rowC = brainCompleteRow(false);
    rowC[0] = 'C';
    const { survivors } = splitBrainCompleteRows([rowA, rowB, rowC]);
    expect(survivors.map((r) => r[0])).toEqual(['A', 'C']);
  });
});

describe('buildThreadStagingWorkingSet', () => {
  it('excludes rows where Row_Status is PROCESSED', () => {
    const workingSet = buildThreadStagingWorkingSet([
      threadStagingRow({ threadId: 'T1', status: 'PENDING' }),
      threadStagingRow({ threadId: 'T2', status: 'PROCESSED' }),
      threadStagingRow({ threadId: 'T3', status: 'ACTIVE' }),
    ]);
    expect(workingSet.map((r) => r.threadId)).toEqual(['T1', 'T3']);
  });

  it('includes any non-PROCESSED status, not just PENDING/ACTIVE', () => {
    const workingSet = buildThreadStagingWorkingSet([
      threadStagingRow({ threadId: 'T1', status: 'SOMETHING_ELSE' }),
    ]);
    expect(workingSet).toHaveLength(1);
  });

  it('assigns the correct physical sheet row (data starts at row 2)', () => {
    const workingSet = buildThreadStagingWorkingSet([
      threadStagingRow({ threadId: 'T1', status: 'PENDING' }),
      threadStagingRow({ threadId: 'T2', status: 'PENDING' }),
    ]);
    expect(workingSet[0]!.sheetRow).toBe(2);
    expect(workingSet[1]!.sheetRow).toBe(3);
  });

  it('keeps the correct sheetRow even when earlier rows are excluded', () => {
    const workingSet = buildThreadStagingWorkingSet([
      threadStagingRow({ threadId: 'T1', status: 'PROCESSED' }),
      threadStagingRow({ threadId: 'T2', status: 'PENDING' }),
    ]);
    expect(workingSet).toHaveLength(1);
    expect(workingSet[0]!.sheetRow).toBe(3); // second physical row, not re-indexed to 2
  });
});
