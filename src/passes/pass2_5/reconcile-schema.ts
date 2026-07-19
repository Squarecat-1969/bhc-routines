/**
 * The reconciliation call only needs to decide ONE thing the LLM is actually
 * needed for: does any candidate interaction topically satisfy this task
 * cluster's request? Spec 2.5d's three verdicts collapse to two real
 * questions — "was it handled" (needs judgment) and, if not, "is it stale"
 * (pure date math: Due_Date >7 days past or not). Splitting it this way
 * keeps the LLM call narrow and single-purpose, per the project's own LLM
 * principle, and moves everything that doesn't need judgment out of the
 * prompt entirely.
 */

import { z } from 'zod';

export const ReconciliationResponseSchema = z
  .object({
    has_evidence: z.boolean(),
    evidence_activity_id: z.string(), // must be one of the candidate IDs when has_evidence is true, else ''
    evidence_quote: z.string(), // <15 words, enforced by the prompt, not re-validated here (word-count isn't a safety property)
    confidence: z.enum(['high', 'medium', '']), // spec: HANDLED_EVIDENCE is only ever high/medium, never low
    brain_reasoning: z.string(),
  })
  .refine((v) => !v.has_evidence || v.confidence !== '', {
    message: 'confidence must be high or medium when has_evidence is true',
  })
  .refine((v) => !v.has_evidence || v.evidence_activity_id !== '', {
    message: 'evidence_activity_id must be set when has_evidence is true',
  });

export type ReconciliationResponse = z.infer<typeof ReconciliationResponseSchema>;

export type ReconciliationParseResult =
  | { readonly ok: true; readonly value: ReconciliationResponse }
  | { readonly ok: false; readonly error: string; readonly rawPreview: string };

export function parseReconciliationResponse(raw: string): ReconciliationParseResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    const tail = stripped.length > 300 ? `…${stripped.slice(-300)}` : stripped;
    return { ok: false, error: `not valid JSON: ${String(e)}`, rawPreview: `(${stripped.length} chars) ${tail}` };
  }

  const result = ReconciliationResponseSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const tail = stripped.length > 300 ? `…${stripped.slice(-300)}` : stripped;
    return { ok: false, error: `schema validation failed: ${issues}`, rawPreview: `(${stripped.length} chars) ${tail}` };
  }

  return { ok: true, value: result.data };
}
