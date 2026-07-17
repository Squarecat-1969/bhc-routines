import { describe, expect, it } from 'vitest';

import { columnLetter } from '../src/passes/pass4/load.js';

describe('columnLetter', () => {
  it('maps 0-based indices to A1 column letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(21)).toBe('V');
    expect(columnLetter(24)).toBe('Y'); // Relationship_Tier, per the real sheet
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(112)).toBe('DI'); // last column of the 113-wide header
    expect(columnLetter(155)).toBe('EZ'); // end of the widened read range
  });
});
