import { describe, expect, it } from 'vitest';
import { fieldEqual, namesExact, norm, sharesWord, sigWords } from '../src/lib/name-match.js';

describe('norm', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(norm("  O'Brien-Smith,  Jr. ")).toBe('o brien smith jr');
  });
  it('keeps accented letters — they are letters, not punctuation', () => {
    expect(norm('Assunção')).toBe('assunção');
  });
  it('treats null/undefined as empty rather than throwing', () => {
    expect(norm(null)).toBe('');
    expect(norm(undefined)).toBe('');
  });
});

describe('namesExact — the STRICT gate', () => {
  it('is case-SENSITIVE: loosening it would turn real conflicts into clean passes', () => {
    expect(namesExact('Bo Geddes', 'bo geddes')).toBe(false);
  });
  it('trims only the outer whitespace', () => {
    expect(namesExact('  Bo Geddes  ', 'Bo Geddes')).toBe(true);
  });
  it('does not treat punctuation differences as equal', () => {
    expect(namesExact("O'Brien", 'OBrien')).toBe(false);
  });
});

describe('sharesWord', () => {
  it('is true on one significant word in common', () => {
    expect(sharesWord('Rachel Marantz', 'Rachel Marantz-Cohen')).toBe(true);
  });
  it('is FALSE when only a particle is shared — particles are not significant', () => {
    expect(sharesWord('Bank of America', 'University of Texas')).toBe(false);
  });
  it('is false for genuinely different people — the A5 case', () => {
    expect(sharesWord('Greg Westhoff', 'Angie Nguyen')).toBe(false);
  });
  it('handles blanks without throwing', () => {
    expect(sharesWord('', 'Someone')).toBe(false);
  });
});

describe('fieldEqual — I1 comparison', () => {
  it('ignores case, punctuation and spacing drift', () => {
    expect(fieldEqual('Head of Content', 'head of  content')).toBe(true);
    expect(fieldEqual('Acme, Inc.', 'Acme Inc')).toBe(true);
  });
  it('still distinguishes genuinely different values', () => {
    expect(fieldEqual('Head of Content', 'Head of Product')).toBe(false);
  });
});

describe('sigWords is the shared definition, not a second one', () => {
  it('drops particles exactly as the name gate does', () => {
    expect([...sigWords('the House of van Gogh')].sort()).toEqual(['gogh', 'house']);
  });
});
