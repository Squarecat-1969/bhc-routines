import { describe, expect, it } from 'vitest';

import { classifyNameDrift, shouldEnqueue } from '../../src/passes/pass4_5/name-conflicts.js';

describe('classifyNameDrift', () => {
  it('is EXACT for a literal match', () => {
    expect(classifyNameDrift('Alice Nguyen', 'Alice Nguyen')).toBe('EXACT');
  });

  it('is EXACT after outer-trim only — inner spacing differences still count as drift', () => {
    expect(classifyNameDrift(' Alice Nguyen ', 'Alice Nguyen')).toBe('EXACT');
    expect(classifyNameDrift('Alice  Nguyen', 'Alice Nguyen')).not.toBe('EXACT');
  });

  it('is EXACT match is case-sensitive — a case difference is NOT exact', () => {
    expect(classifyNameDrift('alice nguyen', 'Alice Nguyen')).not.toBe('EXACT');
  });

  it('is CANDIDATE when names share a significant word but are not identical', () => {
    expect(classifyNameDrift('Alice Nguyen', 'Alice Nguyen-Smith')).toBe('CANDIDATE');
    expect(classifyNameDrift('Bob Smith', 'Robert Smith')).toBe('CANDIDATE'); // shares "smith"
  });

  it('is LEAVE_FOR_RECONCILER when zero significant words are shared', () => {
    expect(classifyNameDrift('Alice Nguyen', 'Robert Chen')).toBe('LEAVE_FOR_RECONCILER');
  });

  it('is LEAVE_FOR_RECONCILER (not CANDIDATE) when a name is unverifiable', () => {
    expect(classifyNameDrift('', 'Alice Nguyen')).toBe('LEAVE_FOR_RECONCILER');
  });
});

describe('shouldEnqueue', () => {
  const candidate = { bhcId: 'BHC-00001', oldName: 'Bob Smith', newName: 'Robert Smith' };

  it('enqueues when no matching row exists at all', () => {
    expect(shouldEnqueue(candidate, [])).toBe(true);
  });

  it('suppresses when a RESOLVED_OLD row exists for the exact key — permanent "keep current"', () => {
    const existing = [{ ...candidate, status: 'RESOLVED_OLD' as const }];
    expect(shouldEnqueue(candidate, existing)).toBe(false);
  });

  it('skips (no duplicate) when an awaiting row (blank status) exists for the exact key', () => {
    const existing = [{ ...candidate, status: '' as const }];
    expect(shouldEnqueue(candidate, existing)).toBe(false);
  });

  it('re-raises (enqueues) when a RESOLVED_NEW row exists — it drifted back', () => {
    const existing = [{ ...candidate, status: 'RESOLVED_NEW' as const }];
    expect(shouldEnqueue(candidate, existing)).toBe(true);
  });

  it('only matches on the exact (bhcId, oldName, newName) triple — a different key does not suppress', () => {
    const existing = [{ bhcId: 'BHC-00002', oldName: 'Bob Smith', newName: 'Robert Smith', status: 'RESOLVED_OLD' as const }];
    expect(shouldEnqueue(candidate, existing)).toBe(true);
  });

  it('RESOLVED_OLD takes priority even if an awaiting row for the same key also exists', () => {
    const existing = [
      { ...candidate, status: '' as const },
      { ...candidate, status: 'RESOLVED_OLD' as const },
    ];
    expect(shouldEnqueue(candidate, existing)).toBe(false);
  });
});
