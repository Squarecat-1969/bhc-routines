/**
 * STEP 4 — one narrow call per contact in the 30-84 band, and the clamp.
 *
 * Not agentic, not conversational, no tools: a single Messages request with a
 * fixed system prompt and a two-field JSON contract, exactly the discipline
 * Late Edition's PASS 2 established.
 */

import { LLM_SCORE_MAX, LLM_SCORE_MIN, LLM_CLAMP_RANGE, TRIAGE_MAX_TOKENS, TRIAGE_MODEL } from '../../config/triage-constants.js';
import type { AnthropicClient } from '../../lib/anthropic.js';
import { buildTriageUserPrompt, TRIAGE_SYSTEM_PROMPT } from './llm-prompt.js';
import { parseTriageVerdict } from './llm-schema.js';
import type { ContactSignals, DeterministicScore, LlmOutcome, UnbridgedContact } from './types.js';

/** Within the score range where a call could still change the outcome. */
export function isInLlmScoreRange(score: number): boolean {
  return score >= LLM_SCORE_MIN && score <= LLM_SCORE_MAX;
}

/**
 * THE GATE: is there anything to read, and is the score not already settled?
 *
 * Evidence is the binding condition, not band position. The first --llm run
 * spent 40 calls and 36 came back citing the absence of readable evidence;
 * both meaningful upward moves went to the two contacts that had a summary or
 * a subject line. A call with nothing to read re-states the deterministic
 * signals and returns "middling", which costs money to learn nothing.
 */
export function shouldCallLlm(signals: ContactSignals, deterministicScore: number): boolean {
  return signals.hasReadableEvidence && isInLlmScoreRange(deterministicScore);
}

/**
 * The clamp. The LLM's score replaces the deterministic one, but never moves
 * it by more than LLM_CLAMP_RANGE — a 32 cannot become a 95.
 *
 * Both scores are stored and every clamp event is logged: frequent clamping
 * means the thresholds or the deterministic weights need tuning, and that
 * signal is only visible if it is counted.
 */
export function applyClamp(deterministic: number, llmScore: number): { final: number; clamped: boolean } {
  const low = Math.max(0, deterministic - LLM_CLAMP_RANGE);
  const high = Math.min(100, deterministic + LLM_CLAMP_RANGE);
  const final = Math.max(low, Math.min(high, llmScore));
  return { final, clamped: final !== llmScore };
}

export interface TriageLlmInput {
  readonly contact: UnbridgedContact;
  readonly signals: ContactSignals;
  readonly deterministic: DeterministicScore;
}

/**
 * One contact, one call. Never throws: a failure returns an outcome carrying
 * the error, and the caller keeps the deterministic score with
 * score_source = "deterministic-fallback". One contact never fails the run.
 */
export async function scoreWithLlm(anthropic: AnthropicClient, input: TriageLlmInput): Promise<LlmOutcome> {
  const { contact, signals, deterministic } = input;

  let raw: string;
  try {
    raw = await anthropic.complete({
      model: TRIAGE_MODEL,
      system: TRIAGE_SYSTEM_PROMPT,
      user: buildTriageUserPrompt(contact, signals, deterministic),
      maxTokens: TRIAGE_MAX_TOKENS,
    });
  } catch (e) {
    return {
      attioRecordId: contact.attioRecordId,
      verdict: null,
      error: `Anthropic call failed: ${String(e)}`,
      clamped: false,
      rawScore: null,
    };
  }

  const parsed = parseTriageVerdict(raw);
  if (!parsed.ok) {
    return {
      attioRecordId: contact.attioRecordId,
      verdict: null,
      error: `response validation failed: ${parsed.error}`,
      clamped: false,
      rawScore: null,
    };
  }

  const { final, clamped } = applyClamp(deterministic.score, parsed.value.score);
  return {
    attioRecordId: contact.attioRecordId,
    verdict: { score: final, reason: parsed.value.reason },
    error: null,
    clamped,
    rawScore: parsed.value.score,
  };
}

export { LLM_SCORE_MIN, LLM_SCORE_MAX };
