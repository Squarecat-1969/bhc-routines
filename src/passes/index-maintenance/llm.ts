/**
 * ONE NARROW CALL PER ENTRY. Not one call over the corpus.
 *
 * The deterministic half already knows which entries are unindexed and what
 * the vocabulary is; the model does one thing only — assign an entry to terms
 * that already exist. Fixed JSON schema, no tools, no conversation.
 *
 * ⚠ THE VOCABULARY IS CONTROLLED. The prompt hands the model the full term
 * list and tells it to choose from it. Anything it invents is returned
 * separately as a PROPOSAL and routed to ADDITIONAL TERMS — never created in a
 * GROUP tab. §089.4: the vocabulary is controlled precisely because free
 * extraction across hundreds of dense entries produces near-duplicates and an
 * index as unscannable as the log.
 *
 * ⚠ A FAILURE-CLASS TERM IS MANDATORY on any entry describing an incident, bug
 * or correction (§089.4, "locked" and still governing). The brief omits this.
 * It is asked for explicitly and checked deterministically afterwards.
 */

import { z } from 'zod';

import type { AnthropicClient } from '../../lib/anthropic.js';
import type { SourceEntry } from './parse.js';
import type { Vocabulary } from './plan.js';

export const INDEX_MODEL = 'claude-sonnet-5';
/**
 * ⚠ 700 WAS NOT ENOUGH AND FAILED IN A WAY THAT LOOKED LIKE A PARSE ERROR.
 * Every one of the first 22 live calls returned `stop_reason=max_tokens` with
 * only a `thinking` block and no text at all — the model spends budget
 * reasoning over a 155-term vocabulary before it writes any JSON. Raised after
 * measuring, and only because the existing response diagnostic named the cause
 * (`block_types=[thinking]`) instead of reporting "no text content".
 */
export const INDEX_MAX_TOKENS = 4000;

/** How much of an entry reaches the prompt. Entries run to a few thousand chars. */
export const ENTRY_CHARS_IN_PROMPT = 3500;

export interface AssignmentVerdict {
  readonly terms: readonly string[];
  readonly proposedTerms: readonly string[];
  readonly reason: string;
}

export interface AssignmentOutcome {
  readonly locator: string;
  readonly verdict: AssignmentVerdict | null;
  readonly error: string | null;
  /** Terms the model returned that are NOT in the vocabulary, moved to proposals. */
  readonly rejected: readonly string[];
  readonly missingFailureClass: boolean;
}

/**
 * The response contract, validated before it can influence a write. An
 * unparseable response is an expected failure mode for an LLM call, so it
 * degrades to "this entry was not assigned" rather than throwing.
 */
export const AssignmentSchema = z.object({
  terms: z.array(z.string()).max(12),
  proposedTerms: z.array(z.string()).max(8),
  reason: z.string(),
});

export type AssignmentParseResult =
  | { readonly ok: true; readonly value: z.infer<typeof AssignmentSchema> }
  | { readonly ok: false; readonly error: string };

export function parseAssignment(raw: string): AssignmentParseResult {
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
  const parsed = AssignmentSchema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/**
 * ⚠ THE CAP IS STATED TO THE MODEL, NOT JUST ENFORCED AFTER THE FACT.
 *
 * The schema has capped `terms` at 12 since this shipped, and NOTHING TOLD THE
 * MODEL. So it returned what the entry deserved — 20, 15 and 20 terms on
 * §092, §096 and §102 — and every one failed validation, produced nothing, and
 * was retried at full cost on the next run. §092 and §096 failed three
 * consecutive runs; §102 two. The run reported green each time.
 *
 * The fix is instruction, not a bigger cap. Raising it would be fitting the
 * rule to its outliers, and the cap exists to stop unbounded assignment — a
 * dense investigation entry legitimately touches twenty concepts, and indexing
 * it under all twenty is how an index becomes unscannable. Told to prioritise,
 * the model loses its MARGINAL terms instead of the whole entry.
 */
const MAX_TERMS = 12;

const SYSTEM = [
  'You assign keywords to one developer-log entry against a CONTROLLED vocabulary.',
  `Reply with JSON only: {"terms": [...at most ${MAX_TERMS}...], "proposedTerms": [...], "reason": "..."}.`,
  `NEVER return more than ${MAX_TERMS} terms — a longer array is rejected outright and the entry goes unindexed.`,
  'No prose, no code fence.',
].join(' ');

export function buildPrompt(entry: SourceEntry, vocabulary: Vocabulary, groupTitles: ReadonlyMap<string, string>): string {
  const groups: string[] = [];
  for (const [tabId, terms] of vocabulary.byTab) {
    const title = groupTitles.get(tabId) ?? tabId;
    groups.push(`${title}\n${terms.map((t) => `  - ${t}`).join('\n')}`);
  }

  return [
    'You are assigning keywords to ONE entry of a developer log, for a keyword index.',
    '',
    'THE VOCABULARY IS CONTROLLED. Choose terms from the list below, matching them EXACTLY as written.',
    'Only if the entry genuinely needs a concept the list cannot express, add it to `proposedTerms`',
    'instead — those are reviewed by a human and never added automatically. Prefer an imperfect',
    'existing term over a new one; near-duplicate terms are what make an index unscannable.',
    '',
    'A FAILURE-CLASS TERM IS MANDATORY if this entry describes an incident, a bug, a correction, or',
    'something that went wrong. Those terms are in the "GROUP: Failure classes" list.',
    '',
    `⚠ RETURN AT MOST ${MAX_TERMS} TERMS. A longer array is REJECTED and the entry is then indexed under`,
    'NOTHING AT ALL — so returning twenty good terms is strictly worse than returning twelve.',
    '',
    `IF MORE THAN ${MAX_TERMS} APPLY, PRIORITISE. Keep, in this order:`,
    '  1. the mandatory failure-class term, if this entry describes something that went wrong;',
    '  2. the terms a reader SEARCHING FOR THIS ENTRY would actually type — what it is chiefly about;',
    '  3. terms specific to this entry over terms that would match hundreds of others.',
    'Drop the marginal ones. A dense entry legitimately touches twenty concepts; indexing it under the',
    'twelve that identify it is the goal, and losing the marginal ones costs far less than losing the entry.',
    '',
    '=== CONTROLLED VOCABULARY ===',
    groups.join('\n\n'),
    '',
    '=== THE ENTRY ===',
    entry.body.slice(0, ENTRY_CHARS_IN_PROMPT),
  ].join('\n');
}

export async function assignTerms(
  anthropic: AnthropicClient,
  args: {
    readonly entry: SourceEntry;
    readonly vocabulary: Vocabulary;
    readonly groupTitles: ReadonlyMap<string, string>;
    readonly failureClassTerms: ReadonlySet<string>;
  },
): Promise<AssignmentOutcome> {
  const { entry, vocabulary, failureClassTerms } = args;
  try {
    const raw = await anthropic.complete({
      model: INDEX_MODEL,
      maxTokens: INDEX_MAX_TOKENS,
      system: SYSTEM,
      user: buildPrompt(entry, vocabulary, args.groupTitles),
    });
    const parsed = parseAssignment(raw);
    if (!parsed.ok) {
      return {
        locator: entry.locator,
        verdict: null,
        error: parsed.error,
        rejected: [],
        missingFailureClass: false,
      };
    }
    const res = parsed.value;

    // ⚠ THE MODEL'S OUTPUT IS FILTERED AGAINST THE VOCABULARY DETERMINISTICALLY.
    // A term it returns that does not exist is not created — it becomes a
    // proposal. Trusting the field name would let the vocabulary drift through
    // the one door that was closed deliberately.
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const t of res.terms ?? []) {
      if (vocabulary.owner.has(t)) accepted.push(t);
      else rejected.push(t);
    }
    const proposals = [...new Set([...(res.proposedTerms ?? []), ...rejected])].filter(
      (t) => !vocabulary.owner.has(t),
    );

    const missingFailureClass = !accepted.some((t) => failureClassTerms.has(t));

    return {
      locator: entry.locator,
      verdict: { terms: [...new Set(accepted)], proposedTerms: proposals, reason: res.reason ?? '' },
      error: null,
      rejected,
      missingFailureClass,
    };
  } catch (error) {
    return {
      locator: entry.locator,
      verdict: null,
      error: error instanceof Error ? error.message : String(error),
      rejected: [],
      missingFailureClass: false,
    };
  }
}
