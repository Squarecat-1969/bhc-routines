/**
 * PASS 2's single enrichment call per thread (spec step "e"). One narrow,
 * single-purpose call with a fixed JSON schema, per the project's own stated
 * LLM principle — not an agentic loop, not multiple calls per thread.
 */

import { ENRICHMENT_MAX_TOKENS, ENRICHMENT_MODEL } from '../../config/constants.js';
import type { AnthropicClient } from '../../lib/anthropic.js';
import { redactSensitiveData } from './guardrail.js';
import { buildEnrichmentUserPrompt, ENRICHMENT_SYSTEM_PROMPT, type ContactContext } from './prompt.js';
import { parseEnrichmentResponse, type EnrichmentResponse } from './enrich-schema.js';
import type { RawEmailMessage } from './types.js';

export interface EnrichmentResult {
  readonly response: EnrichmentResponse;
  readonly warnings: readonly string[];
}

export type EnrichmentOutcome =
  | { readonly ok: true; readonly result: EnrichmentResult }
  | { readonly ok: false; readonly error: string };

/**
 * Deterministic guard for the spec's own named failure mode: "REPLY_NEEDED
 * on a Direction=Outbound thread is almost always wrong... Most common
 * misfire." Rather than only warning, this downgrades REPLY_NEEDED to
 * FYI_ONLY on an Outbound thread and clears response_draft — the spec's
 * language ("almost always wrong", "wrongly assigns") describes a known
 * systematic model error to actively correct, not just monitor. Always
 * returns a warning when it fires, so the override is visible, not silent.
 */
function applyOutboundCeilingGuard(
  response: EnrichmentResponse,
  threadDirection: string,
): { response: EnrichmentResponse; warning: string | null } {
  if (threadDirection !== 'Outbound' || response.action_required !== 'REPLY_NEEDED') {
    return { response, warning: null };
  }
  return {
    response: { ...response, action_required: 'FYI_ONLY', response_draft: '' },
    warning:
      'outbound-ceiling guard fired: model returned REPLY_NEEDED on an Outbound thread — downgraded to FYI_ONLY per spec\'s named misfire pattern',
  };
}

/** Redact-and-warn every free-text output field — defense in depth against the LLM echoing sensitive content it saw in the raw thread. */
function applyGuardrailToResponse(response: EnrichmentResponse): { response: EnrichmentResponse; warnings: string[] } {
  const warnings: string[] = [];
  const fields: (keyof EnrichmentResponse)[] = [
    'running_summary',
    'key_commitments',
    'company_intel',
    'pipeline_signals',
    'brain_notes',
    'response_draft',
    'personal_notes_extract',
    'topics_of_interest_extract',
    'conversation_trigger_extract',
  ];

  const patched: Record<string, unknown> = { ...response };
  for (const field of fields) {
    const value = response[field];
    if (typeof value !== 'string' || value === '') continue;
    const redacted = redactSensitiveData(value);
    if (redacted !== value) {
      patched[field] = redacted;
      warnings.push(`guardrail redacted sensitive content the model echoed into "${field}"`);
    }
  }

  return { response: patched as unknown as EnrichmentResponse, warnings };
}

export async function enrichThread(
  anthropic: AnthropicClient,
  messages: readonly RawEmailMessage[],
  threadDirection: string,
  contactContext: ContactContext | null,
): Promise<EnrichmentOutcome> {
  const userPrompt = buildEnrichmentUserPrompt(messages, threadDirection, contactContext);

  let raw: string;
  try {
    raw = await anthropic.complete({
      model: ENRICHMENT_MODEL,
      system: ENRICHMENT_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: ENRICHMENT_MAX_TOKENS,
    });
  } catch (e) {
    return { ok: false, error: `Anthropic call failed: ${String(e)}` };
  }

  const parsed = parseEnrichmentResponse(raw);
  if (!parsed.ok) {
    return { ok: false, error: `response validation failed: ${parsed.error}` };
  }

  const warnings: string[] = [];
  const { response: guardedResponse, warning: ceilingWarning } = applyOutboundCeilingGuard(parsed.value, threadDirection);
  if (ceilingWarning) warnings.push(ceilingWarning);

  const { response: redactedResponse, warnings: redactionWarnings } = applyGuardrailToResponse(guardedResponse);
  warnings.push(...redactionWarnings);

  return { ok: true, result: { response: redactedResponse, warnings } };
}
