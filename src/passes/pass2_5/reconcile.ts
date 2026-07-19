/**
 * Combines the narrow LLM call (evidence question only) with the
 * deterministic STALE-vs-GENUINELY_OPEN date math (spec 2.5d) to produce the
 * full three-verdict result the spec actually asks for.
 */

import type { AnthropicClient } from '../../lib/anthropic.js';
import { diffDays, parseFlexibleDate, type CivilDate } from '../../lib/dates.js';
import { buildReconciliationUserPrompt, RECONCILIATION_SYSTEM_PROMPT } from './reconcile-prompt.js';
import { parseReconciliationResponse } from './reconcile-schema.js';
import type { ActivityLogCandidate, ReconciliationResult, TaskCluster } from './types.js';

const STALE_THRESHOLD_DAYS = 7;
const RECONCILIATION_MODEL = 'claude-sonnet-5';
const RECONCILIATION_MAX_TOKENS = 1000;

export type ReconcileOutcome =
  | { readonly ok: true; readonly result: ReconciliationResult }
  | { readonly ok: false; readonly error: string };

function resolveNoEvidenceVerdict(cluster: TaskCluster, today: CivilDate): Pick<ReconciliationResult, 'verdict' | 'proposedCompletionDate' | 'confidence'> {
  const due = parseFlexibleDate(cluster.latestDueDate);
  const daysPastDue = due ? diffDays(today, due) : null;

  if (daysPastDue !== null && daysPastDue > STALE_THRESHOLD_DAYS) {
    return { verdict: 'LIKELY_STALE_NO_EVIDENCE', proposedCompletionDate: cluster.latestDueDate, confidence: 'low' };
  }
  return { verdict: 'GENUINELY_OPEN', proposedCompletionDate: '', confidence: '' };
}

export async function reconcileCluster(
  anthropic: AnthropicClient,
  cluster: TaskCluster,
  candidates: readonly ActivityLogCandidate[],
  today: CivilDate,
): Promise<ReconcileOutcome> {
  // No candidates at all — skip the LLM call entirely, it has nothing to evaluate.
  if (candidates.length === 0) {
    const { verdict, proposedCompletionDate, confidence } = resolveNoEvidenceVerdict(cluster, today);
    return {
      ok: true,
      result: {
        cluster,
        verdict,
        evidenceQuote: '',
        evidenceSource: '',
        proposedCompletionDate,
        confidence,
        brainReasoning: 'No candidate interactions found since the task was created.',
      },
    };
  }

  const userPrompt = buildReconciliationUserPrompt(cluster, candidates);

  let raw: string;
  try {
    raw = await anthropic.complete({
      model: RECONCILIATION_MODEL,
      system: RECONCILIATION_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: RECONCILIATION_MAX_TOKENS,
    });
  } catch (e) {
    return { ok: false, error: `Anthropic call failed: ${String(e)}` };
  }

  const parsed = parseReconciliationResponse(raw);
  if (!parsed.ok) {
    return { ok: false, error: `response validation failed: ${parsed.error}` };
  }

  const response = parsed.value;

  if (!response.has_evidence) {
    const { verdict, proposedCompletionDate, confidence } = resolveNoEvidenceVerdict(cluster, today);
    return {
      ok: true,
      result: { cluster, verdict, evidenceQuote: '', evidenceSource: '', proposedCompletionDate, confidence, brainReasoning: response.brain_reasoning },
    };
  }

  // has_evidence: true — verify the model actually picked a real candidate,
  // don't trust an activity_id it might have hallucinated.
  const matchedCandidate = candidates.find((c) => c.activityId === response.evidence_activity_id);
  if (!matchedCandidate) {
    return { ok: false, error: `model claimed evidence from activity_id "${response.evidence_activity_id}", which isn't in the candidate list` };
  }

  return {
    ok: true,
    result: {
      cluster,
      verdict: 'LIKELY_HANDLED_EVIDENCE',
      evidenceQuote: response.evidence_quote,
      evidenceSource: matchedCandidate.activityId,
      proposedCompletionDate: matchedCandidate.timestamp.slice(0, 10),
      confidence: response.confidence === '' ? 'medium' : response.confidence,
      brainReasoning: response.brain_reasoning,
    },
  };
}
