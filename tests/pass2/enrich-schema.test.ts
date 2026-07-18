import { describe, expect, it } from 'vitest';

import { parseEnrichmentResponse } from '../../src/passes/pass2/enrich-schema.js';

const VALID_RESPONSE = {
  running_summary: 'Caught up on the project timeline.',
  key_commitments: 'Bobby to send contract by Friday.',
  personal_details_flag: false,
  company_intel: '',
  pipeline_signals: '',
  brain_notes: '',
  action_required: 'FYI_ONLY',
  response_draft: '',
  tasks: [],
  ready_to_archive: false,
  personal_notes_extract: '',
  topics_of_interest_extract: '',
  conversation_trigger_extract: '',
};

describe('parseEnrichmentResponse', () => {
  it('parses a valid response', () => {
    const result = parseEnrichmentResponse(JSON.stringify(VALID_RESPONSE));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action_required).toBe('FYI_ONLY');
  });

  it('strips a ```json code fence (a common model habit despite instructions)', () => {
    const wrapped = '```json\n' + JSON.stringify(VALID_RESPONSE) + '\n```';
    const result = parseEnrichmentResponse(wrapped);
    expect(result.ok).toBe(true);
  });

  it('strips a bare ``` fence with no language tag', () => {
    const wrapped = '```\n' + JSON.stringify(VALID_RESPONSE) + '\n```';
    const result = parseEnrichmentResponse(wrapped);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid JSON without throwing', () => {
    const result = parseEnrichmentResponse('not json at all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('CRITICAL SAFETY PROPERTY: rejects key_commitments as a participant-keyed object', () => {
    // This is the exact failure shape the spec warns crashes the Aida UI
    // (React error #31). The schema must reject it, not coerce or accept it.
    const bad = { ...VALID_RESPONSE, key_commitments: { bobby: 'send contract', lana: 'confirm dates' } };
    const result = parseEnrichmentResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('key_commitments');
  });

  it('rejects an invalid action_required enum value', () => {
    const bad = { ...VALID_RESPONSE, action_required: 'MAYBE_LATER' };
    const result = parseEnrichmentResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a response missing a required field', () => {
    const { running_summary: _drop, ...bad } = VALID_RESPONSE;
    void _drop;
    const result = parseEnrichmentResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects personal_details_flag as a non-boolean', () => {
    const bad = { ...VALID_RESPONSE, personal_details_flag: 'yes' };
    const result = parseEnrichmentResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('accepts a populated tasks array with the right shape', () => {
    const withTasks = { ...VALID_RESPONSE, tasks: [{ description: 'Send deck', due_date: '2026-08-01', priority: 'high' }] };
    const result = parseEnrichmentResponse(JSON.stringify(withTasks));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tasks).toHaveLength(1);
  });

  it('rejects a malformed task entry (missing a required task field)', () => {
    const bad = { ...VALID_RESPONSE, tasks: [{ description: 'Send deck' }] }; // missing due_date, priority
    const result = parseEnrichmentResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('preserves the raw text on failure, for debugging/logging', () => {
    const result = parseEnrichmentResponse('garbage');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe('garbage');
  });
});
