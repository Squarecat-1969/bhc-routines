import { describe, expect, it } from 'vitest';

import { parseReconciliationResponse } from '../../src/passes/pass2_5/reconcile-schema.js';

const NO_EVIDENCE = { has_evidence: false, evidence_activity_id: '', evidence_quote: '', confidence: '', brain_reasoning: 'No matching interaction found.' };
const WITH_EVIDENCE = { has_evidence: true, evidence_activity_id: 'ACT-1', evidence_quote: 'signed and sent back', confidence: 'high', brain_reasoning: 'Contract was returned signed.' };

describe('parseReconciliationResponse', () => {
  it('parses a valid no-evidence response', () => {
    const result = parseReconciliationResponse(JSON.stringify(NO_EVIDENCE));
    expect(result.ok).toBe(true);
  });

  it('parses a valid evidence-found response', () => {
    const result = parseReconciliationResponse(JSON.stringify(WITH_EVIDENCE));
    expect(result.ok).toBe(true);
  });

  it('strips a markdown fence', () => {
    const result = parseReconciliationResponse('```json\n' + JSON.stringify(NO_EVIDENCE) + '\n```');
    expect(result.ok).toBe(true);
  });

  it('SAFETY: rejects has_evidence=true with confidence unset', () => {
    const bad = { ...WITH_EVIDENCE, confidence: '' };
    const result = parseReconciliationResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('SAFETY: rejects has_evidence=true with evidence_activity_id unset', () => {
    const bad = { ...WITH_EVIDENCE, evidence_activity_id: '' };
    const result = parseReconciliationResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid confidence value', () => {
    const bad = { ...WITH_EVIDENCE, confidence: 'low' }; // spec: HANDLED_EVIDENCE is only ever high/medium
    const result = parseReconciliationResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON without throwing', () => {
    const result = parseReconciliationResponse('not json');
    expect(result.ok).toBe(false);
  });

  it('includes a raw preview on failure', () => {
    const result = parseReconciliationResponse('garbage output');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rawPreview).toContain('garbage output');
  });
});
