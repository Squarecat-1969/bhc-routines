import { describe, expect, it } from 'vitest';

import { isDiacriticOnlyVariant, stripDiacritics } from '../src/lib/name-verify.js';

describe('stripDiacritics', () => {
  it('removes combining accent marks while leaving the base letters intact', () => {
    expect(stripDiacritics('Emídio')).toBe('Emidio');
    expect(stripDiacritics('Håkon')).toBe('Hakon');
    expect(stripDiacritics('Régina')).toBe('Regina');
    expect(stripDiacritics('Chloé')).toBe('Chloe');
    expect(stripDiacritics('Moreán')).toBe('Morean');
  });

  it('is a no-op on names with no diacritics', () => {
    expect(stripDiacritics('Rafael Emidio')).toBe('Rafael Emidio');
  });

  it('does not touch capitalization, spacing, or punctuation', () => {
    expect(stripDiacritics('bo geddes')).toBe('bo geddes');
    expect(stripDiacritics("James Rolfe 'jr'")).toBe("James Rolfe 'jr'");
  });
});

describe('isDiacriticOnlyVariant', () => {
  it('is true for the real July 2026 diacritic-restoration cases', () => {
    expect(isDiacriticOnlyVariant('Rafael Emidio', 'Rafael Emídio')).toBe(true);
    expect(isDiacriticOnlyVariant('Tome Teixeira', 'Tomé Teixeira')).toBe(true);
    expect(isDiacriticOnlyVariant('Omar Alberto Morean Williams', 'Omar Alberto Moreán Williams')).toBe(true);
    expect(isDiacriticOnlyVariant('Hakon Espeland', 'Håkon Espeland')).toBe(true);
    expect(isDiacriticOnlyVariant('Chloe McLennan', 'Chloé McLennan')).toBe(true);
    expect(isDiacriticOnlyVariant('Bjorn Ahlstedt', 'Björn Ahlstedt')).toBe(true);
    expect(isDiacriticOnlyVariant('Regina Fina', 'Régina Fina')).toBe(true);
  });

  it('is symmetric — order of the two names does not matter', () => {
    expect(isDiacriticOnlyVariant('Håkon Espeland', 'Hakon Espeland')).toBe(true);
  });

  it('is false when strings are identical — not a "variant" of itself', () => {
    expect(isDiacriticOnlyVariant('Rafael Emídio', 'Rafael Emídio')).toBe(false);
  });

  it('is false for an appended enrichment artifact, even though the base name is a prefix', () => {
    expect(isDiacriticOnlyVariant('Carolina Valdovinos', 'Carolina Valdovinos - AllSTEM')).toBe(false);
  });

  it('is false for malformed punctuation added around an otherwise-identical name', () => {
    expect(isDiacriticOnlyVariant('James Rolfe jr', "James Rolfe 'jr'")).toBe(false);
  });

  it('is false for a genuine judgment call with no diacritic relationship at all', () => {
    expect(isDiacriticOnlyVariant('Joleen Winther Hughes', 'Joleen Hughes')).toBe(false);
    expect(isDiacriticOnlyVariant('Dzhuliana El-Kakhat', 'Juliana El-Kakhat')).toBe(false);
  });

  it('is false for a capitalization-only difference — deliberately out of scope', () => {
    expect(isDiacriticOnlyVariant('bo geddes', 'Bo Geddes')).toBe(false);
  });

  it('is false when either name is blank', () => {
    expect(isDiacriticOnlyVariant('', 'Rafael Emídio')).toBe(false);
    expect(isDiacriticOnlyVariant('Rafael Emidio', '')).toBe(false);
    expect(isDiacriticOnlyVariant('', '')).toBe(false);
  });

  it('is false for a genuine spelling difference that happens to also involve accented letters', () => {
    // "Håken" vs "Håkon" — differs in a base letter (e/o), not just an accent.
    expect(isDiacriticOnlyVariant('Håken Espeland', 'Håkon Espeland')).toBe(false);
  });
});
