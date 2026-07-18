import { describe, expect, it } from 'vitest';

import { findSensitiveMatches, hasSensitiveData, redactSensitiveData } from '../../src/passes/pass2/guardrail.js';

describe('findSensitiveMatches / hasSensitiveData', () => {
  it('detects a valid credit card number (Luhn-checked)', () => {
    // 4111 1111 1111 1111 is the standard Visa test number, passes Luhn.
    expect(hasSensitiveData('my card is 4111 1111 1111 1111')).toBe(true);
  });

  it('does not flag a random 16-digit number that fails the Luhn check', () => {
    expect(hasSensitiveData('reference number 1234567890123456')).toBe(false);
  });

  it('detects an SSN pattern', () => {
    expect(hasSensitiveData('SSN: 123-45-6789')).toBe(true);
  });

  it('detects a labeled API key', () => {
    expect(hasSensitiveData('api_key=FAKE_TEST_TOKEN_NOT_REAL_1234567890')).toBe(true);
  });

  it('detects a labeled password', () => {
    expect(hasSensitiveData('password: hunter2isnotsecure')).toBe(true);
  });

  it('is clean for ordinary business content', () => {
    expect(hasSensitiveData('Let\'s meet Friday at 10:30 to discuss the proposal.')).toBe(false);
  });

  it('findSensitiveMatches never returns the raw value, only redacted', () => {
    const matches = findSensitiveMatches('SSN: 123-45-6789');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.redacted).not.toContain('123-45-6789');
    expect(matches[0]!.redacted).toContain('*');
  });
});

describe('redactSensitiveData', () => {
  it('replaces a credit card number with a category placeholder', () => {
    const out = redactSensitiveData('card: 4111 1111 1111 1111');
    expect(out).not.toContain('4111');
    expect(out).toContain('[REDACTED_CARD]');
  });

  it('replaces an SSN with a category placeholder', () => {
    expect(redactSensitiveData('SSN 123-45-6789')).toBe('SSN [REDACTED_SSN]');
  });

  it('leaves clean text untouched', () => {
    const clean = 'Great meeting today, talk soon.';
    expect(redactSensitiveData(clean)).toBe(clean);
  });
});
