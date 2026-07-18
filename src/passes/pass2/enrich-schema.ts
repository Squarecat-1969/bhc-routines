/**
 * The enrichment call's response contract. `z.string()` on key_commitments
 * etc. IS the enforcement for the spec's explicit warning ("Never write a
 * participant-keyed object — e.g. {"bobby": "...", "lana": "..."} — into any
 * Brain_Complete column... That object shape bypasses TypeScript's string
 * guard and crashes the Aida UI with React error #31") — if the model
 * returns an object instead of a string, `.parse()` throws here, before it
 * ever reaches a sheet.
 */

import { z } from 'zod';

import { OUTCOME_VALUES } from './write-targets.js';

export const ACTION_REQUIRED_VALUES = ['REPLY_NEEDED', 'ACTION_ITEM', 'FYI_ONLY', 'NO_ACTION'] as const;

const TaskSchema = z.object({
  description: z.string(),
  due_date: z.string(), // '' if none — validated as a real date only if non-empty, by the caller
  priority: z.string(),
});

export const EnrichmentResponseSchema = z.object({
  running_summary: z.string(),
  key_commitments: z.string(),
  personal_details_flag: z.boolean(),
  company_intel: z.string(),
  pipeline_signals: z.string(),
  brain_notes: z.string(),
  action_required: z.enum(ACTION_REQUIRED_VALUES),
  outcome: z.enum(OUTCOME_VALUES),
  response_draft: z.string(), // '' when action_required !== 'REPLY_NEEDED'
  tasks: z.array(TaskSchema),
  ready_to_archive: z.boolean(),
  personal_notes_extract: z.string(),
  topics_of_interest_extract: z.string(),
  conversation_trigger_extract: z.string(),
});

export type EnrichmentResponse = z.infer<typeof EnrichmentResponseSchema>;

export type EnrichmentParseResult =
  | { readonly ok: true; readonly value: EnrichmentResponse }
  | { readonly ok: false; readonly error: string; readonly raw: string };

/**
 * Strips a ```json fence if present (a common model habit despite
 * instructions not to), then parses and validates. Never throws — a
 * malformed response is a legitimate, expected failure mode for an LLM call,
 * not a bug; the caller decides what to do (skip the thread, retry, flag it).
 */
export function parseEnrichmentResponse(raw: string): EnrichmentParseResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}`, raw };
  }

  const result = EnrichmentResponseSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `schema validation failed: ${issues}`, raw };
  }

  return { ok: true, value: result.data };
}
