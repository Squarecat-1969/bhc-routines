/**
 * The STEP 4 response contract: `{ score: 0-100, reason: "one sentence" }` and
 * nothing else. Validation happens before the value can influence a score, so
 * a malformed response degrades to the deterministic fallback rather than
 * writing a garbage number into the queue.
 */

import { z } from 'zod';

export const TriageVerdictSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().min(1),
});

export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;

export type TriageParseResult =
  | { readonly ok: true; readonly value: TriageVerdict }
  | { readonly ok: false; readonly error: string };

/**
 * Strips a ```json fence if the model added one, then parses and validates.
 * Never throws — an unparseable response is an expected failure mode for an
 * LLM call, and the caller keeps the deterministic score when it happens.
 */
export function parseTriageVerdict(raw: string): TriageParseResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}` };
  }

  const result = TriageVerdictSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `schema validation failed: ${issues}` };
  }

  // A reason is required, but a model that pads it into an essay is defeating
  // the "one sentence" contract the card renders. Trim rather than reject.
  const reason = result.data.reason.trim().replace(/\s+/g, ' ').slice(0, 300);
  return { ok: true, value: { score: result.data.score, reason } };
}
