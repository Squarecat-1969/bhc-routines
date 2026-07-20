import { describe, expect, it } from 'vitest';
import { detectSensitiveData, sanitizeField } from '../../src/part-d/sensitive-data.js';

describe('detectSensitiveData — real detections', () => {
  it('detects a Luhn-valid credit card number (standard public test number, not a real card)', () => {
    expect(detectSensitiveData('here is the card 4111111111111111 for the deposit')?.category).toBe('credit_card');
  });

  it('detects a Luhn-valid card number with spaces or dashes', () => {
    expect(detectSensitiveData('4111-1111-1111-1111')?.category).toBe('credit_card');
    expect(detectSensitiveData('4111 1111 1111 1111')?.category).toBe('credit_card');
  });

  it('detects an SSN-shaped number', () => {
    expect(detectSensitiveData('SSN is 123-45-6789 on file')?.category).toBe('ssn');
  });

  it('detects an explicit password/credential label', () => {
    expect(detectSensitiveData('password: hunter2')?.category).toBe('credential');
    expect(detectSensitiveData('api_key=sk-abc123xyz')?.category).toBe('credential');
    expect(detectSensitiveData('Access Token: abc.def.ghi')?.category).toBe('credential');
  });

  it('detects a labeled bank routing or account number', () => {
    expect(detectSensitiveData('routing number: 123456789')?.category).toBe('bank_account');
    expect(detectSensitiveData('account number: 000123456789')?.category).toBe('bank_account');
  });
});

describe('detectSensitiveData — does not false-positive on ordinary business content', () => {
  it('leaves a normal running summary alone', () => {
    expect(detectSensitiveData('Alice confirmed the Q3 contract terms and wants to schedule a follow-up call next week.')).toBeNull();
  });

  it('leaves phone numbers and dates alone', () => {
    expect(detectSensitiveData('Call me at 555-123-4567 tomorrow, July 25th 2026.')).toBeNull();
  });

  it('leaves a short reference or order number alone', () => {
    expect(detectSensitiveData('Order #48213 shipped yesterday.')).toBeNull();
  });

  it('leaves a random 16-digit-looking sequence alone when it fails the Luhn check', () => {
    // Deliberately NOT Luhn-valid — a tracking number or similar that
    // happens to be the right length but isn't actually a card number.
    expect(detectSensitiveData('Tracking: 1234567890123456')).toBeNull();
  });

  it('leaves an empty string alone', () => {
    expect(detectSensitiveData('')).toBeNull();
  });
});

describe('sanitizeField', () => {
  it('returns the original text unchanged and no warning when clean', () => {
    const result = sanitizeField('Alice confirmed the contract.', 'runningSummary');
    expect(result.value).toBe('Alice confirmed the contract.');
    expect(result.warning).toBeNull();
  });

  it('returns an empty string and a warning when sensitive data is detected — never the original text', () => {
    const result = sanitizeField('card is 4111111111111111', 'runningSummary');
    expect(result.value).toBe('');
    expect(result.warning).toContain('runningSummary');
    expect(result.warning).toContain('credit_card');
    // The warning names the category, never echoes the matched value back
    expect(result.warning).not.toContain('4111111111111111');
  });
});
