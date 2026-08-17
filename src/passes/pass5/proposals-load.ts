/**
 * Reads PENDING rows from Pipeline_Proposals for PASS 5's opportunity bucket.
 *
 * Read-only. PASS 5 renders proposals; it never resolves them — Accept/Reject
 * and the Attio pipeline-entry creation both live in bhc-aida, on a human
 * decision. Nothing here writes.
 *
 * Column order is the tab's own header, verified live 2026-08-17 and shared
 * with PASS 4f's writer (opportunity-scan.ts's toSheetRow).
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { Pass5PipelineProposal } from './types.js';

const COL = {
  proposalId: 0, // A
  attioRecordId: 1, // B
  bhcId: 2, // C
  contactName: 3, // D
  companyName: 4, // E
  evidence: 5, // F
  proposedTrack: 6, // G
  status: 9, // J
} as const;

export async function loadPipelineProposals(sheets: SheetsClient): Promise<readonly Pass5PipelineProposal[]> {
  const rows = await sheets.read(RANGES.pipelineProposalsData);
  return rows
    // A row with no Proposal_ID is a blank or a cleared row, not a proposal.
    .filter((r) => cell(r, COL.proposalId) !== '')
    .map((r) => ({
      proposalId: cell(r, COL.proposalId),
      attioRecordId: cell(r, COL.attioRecordId),
      bhcId: cell(r, COL.bhcId),
      contactName: cell(r, COL.contactName),
      companyName: cell(r, COL.companyName),
      evidence: cell(r, COL.evidence),
      proposedTrack: cell(r, COL.proposedTrack),
      status: cell(r, COL.status),
    }));
}
