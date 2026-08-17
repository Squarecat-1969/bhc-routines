/**
 * PASS 4f — opportunity proposals.
 *
 * Detects real people carrying an "Opportunity Emerging" signal who have NO
 * entry on the Attio pipeline list, and stages them as rows in
 * Pipeline_Proposals for a human to Accept or Reject in bhc-aida.
 *
 * DETECTION ONLY. This never creates the Attio list entry — that happens later,
 * on human Accept, on the bhc-aida side. The whole point of staging is that a
 * machine-detected signal does not become a pipeline commitment without a
 * person saying yes, the same stage → resolve → execute discipline Late Edition
 * uses everywhere else.
 *
 * Pure: takes already-fetched data and returns what to write. No I/O, no clock,
 * no randomness — so it is testable without credentials, and the caller owns
 * every side effect. Same shape as evaluateContact.
 */

import type { AttioPersonRecord } from '../../lib/attio.js';
import { nameOf, textOf } from '../../lib/attio.js';
import type { MasterIdIndex } from './load.js';

/** Written to Status on every new row. bhc-aida moves it to ACCEPTED / REJECTED. */
export const PROPOSAL_STATUS_PENDING = 'PENDING';

/**
 * Default track for a new proposal. Deliberate, not a placeholder: there is no
 * per-contact track signal designed yet, and inventing one from job title or
 * company would be a guess dressed as a decision. A human picks the real track
 * on Accept.
 */
export const DEFAULT_PROPOSED_TRACK = 'TNB';

/** Evidence is read by a human deciding yes/no, so keep enough summary to judge. */
const SUMMARY_EXCERPT_MAX = 400;

export interface PipelineProposal {
  readonly proposalId: string;
  readonly attioRecordId: string;
  readonly bhcId: string;
  readonly contactName: string;
  readonly companyName: string;
  readonly evidence: string;
  readonly proposedTrack: string;
  readonly detectedAt: string;
  readonly runId: string;
  readonly status: string;
}

export type ExclusionRule =
  | 'already_on_pipeline'
  | 'no_master_id_row'
  | 'synthetic_test_record'
  | 'already_proposed';

export interface ExclusionNote {
  readonly recordId: string;
  readonly name: string;
  readonly rule: ExclusionRule;
  readonly detail: string;
}

export interface OpportunityScanInput {
  /** People already fetched by the caller's filtered query. */
  readonly people: readonly AttioPersonRecord[];
  /** Record IDs of the pipeline entries PASS 4 already loaded — reused, not re-fetched. */
  readonly pipelineRecordIds: ReadonlySet<string>;
  readonly master: MasterIdIndex;
  /**
   * Attio_Record_ID of EVERY existing Pipeline_Proposals row, in ANY status.
   * Rejected proposals count: a rejection is a decision, and re-proposing a
   * record a human already declined would relitigate it every single night.
   */
  readonly existingProposalRecordIds: ReadonlySet<string>;
  readonly runId: string;
  /** ISO-8601, supplied by the caller — this function never reads a clock. */
  readonly detectedAt: string;
}

export interface OpportunityScanResult {
  readonly proposals: readonly PipelineProposal[];
  readonly exclusions: readonly ExclusionNote[];
  readonly counts: {
    readonly candidates: number;
    readonly excludedOnPipeline: number;
    readonly excludedNoMasterId: number;
    readonly excludedSynthetic: number;
    readonly excludedAlreadyProposed: number;
    readonly proposed: number;
  };
}

/**
 * A seeded/synthetic test record masquerading as a real contact.
 *
 * The Master_ID check alone does NOT catch these — verified live: the known
 * seed record (David Park, BHC-02379) has a perfectly real Master_ID row at
 * row 468, complete with a Google row and an Attio record ID. It would sail
 * straight through into a proposal.
 *
 * What actually separates it is its Fathom call id: `999999999`. Checked across
 * all 22 live candidates — exactly one matches a repeated-digit id, and it is
 * that seed record; every genuine call id is an ordinary Fathom identifier.
 *
 * Deliberately narrow. The same record's subject line reads "Meeting: Test
 * Meeting Final 8", which is a second, more tempting signal — and NOT used
 * here, because "test" in a subject is a thing real meetings say ("Test
 * Meeting Final 8" is unmistakable; "A/B test review" is not) and silently
 * dropping a real opportunity is the worse failure. A sentinel call id is
 * unambiguous; a keyword in prose is not.
 */
export function looksSynthetic(record: AttioPersonRecord): { synthetic: boolean; detail: string } {
  const url = textOf(record.values, 'last_interaction_url') ?? '';
  const m = /\/calls\/(\d+)/.exec(url);
  const callId = m?.[1];
  if (callId && /^(\d)\1{5,}$/.test(callId)) {
    return { synthetic: true, detail: `sentinel Fathom call id ${callId}` };
  }
  return { synthetic: false, detail: '' };
}

/** Evidence a human reads to decide — the real outcome text plus real summary. */
export function buildEvidence(record: AttioPersonRecord): string {
  const outcome = (textOf(record.values, 'last_interaction_outcome') ?? '').trim();
  const summary = (textOf(record.values, 'last_meeting_summary') ?? '').trim();
  const subject = (textOf(record.values, 'last_interaction_subject') ?? '').trim();

  const parts: string[] = [];
  if (outcome) parts.push(outcome);
  if (subject) parts.push(`re: ${subject}`);
  if (summary) {
    const excerpt =
      summary.length > SUMMARY_EXCERPT_MAX ? `${summary.slice(0, SUMMARY_EXCERPT_MAX - 1)}…` : summary;
    parts.push(excerpt);
  }
  return parts.join(' — ');
}

/**
 * Deterministic proposal id: derived from the record, never from a clock or a
 * random source, so the same record always yields the same id and a re-run
 * cannot mint a second identifier for a proposal that already exists.
 */
export function makeProposalId(attioRecordId: string): string {
  return `PROP-${attioRecordId.slice(0, 8)}`;
}

export function scanForOpportunities(input: OpportunityScanInput): OpportunityScanResult {
  const { people, pipelineRecordIds, master, existingProposalRecordIds, runId, detectedAt } = input;

  const proposals: PipelineProposal[] = [];
  const exclusions: ExclusionNote[] = [];
  let excludedOnPipeline = 0;
  let excludedNoMasterId = 0;
  let excludedSynthetic = 0;
  let excludedAlreadyProposed = 0;

  for (const record of people) {
    const bhcId = textOf(record.values, 'bhc_contact_id') ?? '';
    const masterEntry = bhcId ? master.byBhcId.get(bhcId) : undefined;
    // Attio's name attribute is occasionally empty on a real record; Master_ID
    // carries the authoritative name, so fall back to it rather than staging a
    // proposal a human cannot identify.
    const name = nameOf(record.values) ?? masterEntry?.fullName ?? '';

    // (a) already covered by a pipeline entry — nothing to propose.
    if (pipelineRecordIds.has(record.recordId)) {
      excludedOnPipeline += 1;
      exclusions.push({ recordId: record.recordId, name, rule: 'already_on_pipeline', detail: 'already has a pipeline list entry' });
      continue;
    }

    // (b) identity gate — no real Master_ID row, no proposal. Never guess.
    if (!masterEntry) {
      excludedNoMasterId += 1;
      exclusions.push({
        recordId: record.recordId,
        name,
        rule: 'no_master_id_row',
        detail: bhcId ? `bhc_contact_id ${bhcId} has no Master_ID row` : 'no bhc_contact_id on the record',
      });
      continue;
    }

    // (b2) synthetic seed data that passes (b) — see looksSynthetic.
    const synthetic = looksSynthetic(record);
    if (synthetic.synthetic) {
      excludedSynthetic += 1;
      exclusions.push({ recordId: record.recordId, name, rule: 'synthetic_test_record', detail: synthetic.detail });
      continue;
    }

    // (c) already proposed, in ANY status — never re-propose, ever.
    if (existingProposalRecordIds.has(record.recordId)) {
      excludedAlreadyProposed += 1;
      exclusions.push({ recordId: record.recordId, name, rule: 'already_proposed', detail: 'a Pipeline_Proposals row already exists for this record' });
      continue;
    }

    proposals.push({
      proposalId: makeProposalId(record.recordId),
      attioRecordId: record.recordId,
      bhcId,
      contactName: name,
      companyName: textOf(record.values, 'company_name') ?? '',
      evidence: buildEvidence(record),
      proposedTrack: DEFAULT_PROPOSED_TRACK,
      detectedAt,
      runId,
      status: PROPOSAL_STATUS_PENDING,
    });
  }

  return {
    proposals,
    exclusions,
    counts: {
      candidates: people.length,
      excludedOnPipeline,
      excludedNoMasterId,
      excludedSynthetic,
      excludedAlreadyProposed,
      proposed: proposals.length,
    },
  };
}

/** The 12-column A-L row shape, matching the tab's existing header order exactly. */
export function toSheetRow(p: PipelineProposal): readonly unknown[] {
  return [
    p.proposalId, // A
    p.attioRecordId, // B
    p.bhcId, // C
    p.contactName, // D
    p.companyName, // E
    p.evidence, // F
    p.proposedTrack, // G
    p.detectedAt, // H
    p.runId, // I
    p.status, // J
    '', // K Resolved_At — set by bhc-aida on Accept/Reject
    '', // L Reject_Reason
  ];
}
