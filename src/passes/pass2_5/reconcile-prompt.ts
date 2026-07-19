import type { ActivityLogCandidate, TaskCluster } from './types.js';

export const RECONCILIATION_SYSTEM_PROMPT = `You are checking whether an open task has already been handled, based on a contact's interaction history. You will be given a task request and a list of candidate interactions (already filtered: same contact, real human interactions only, not automated, not the interaction that created the task, dated on or after the task was created). Read the candidates and decide whether any of them topically satisfies the request — actually addresses what was asked, not just mentions the same topic in passing.

This is a HARD GATE: only report evidence when the candidate genuinely resolves the request. A candidate that merely references the same subject without actually completing the ask does not count. When genuinely uncertain, report no evidence — a missed close is harmless; a wrongly-claimed close could make Bobby think something is done when it isn't.

Return exactly one JSON object, no markdown fences, no preamble:
{
  "has_evidence": true or false,
  "evidence_activity_id": "the activity_id of the single best matching candidate, or empty string if has_evidence is false",
  "evidence_quote": "a direct quote from that candidate's body, under 15 words, proving it satisfies the request — or empty string if has_evidence is false",
  "confidence": "high" | "medium" | "" — high only when the match is unambiguous, medium when reasonably confident but not certain, empty string when has_evidence is false,
  "brain_reasoning": "one sentence explaining the verdict either way"
}`;

function formatCandidate(c: ActivityLogCandidate): string {
  return [
    `--- Candidate (activity_id: ${c.activityId}) ---`,
    `Date: ${c.timestamp} | Channel: ${c.channel} | Direction: ${c.direction}`,
    c.subject ? `Subject: ${c.subject}` : null,
    `Body: ${c.body}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

export function buildReconciliationUserPrompt(cluster: TaskCluster, candidates: readonly ActivityLogCandidate[]): string {
  return [
    `Task request: ${cluster.description}`,
    `Contact: ${cluster.contactName}`,
    `Task created: ${cluster.earliestCreatedAt}`,
    cluster.tasks.length > 1 ? `(This request was logged ${cluster.tasks.length} times across channels — treated as one request.)` : null,
    '',
    candidates.length === 0
      ? 'No candidate interactions to review.'
      : `Candidate interactions since the task was created:\n${candidates.map(formatCandidate).join('\n\n')}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
