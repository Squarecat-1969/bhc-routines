/**
 * PASS 4f — the I/O half of opportunity detection. All judgment lives in the
 * pure scanForOpportunities; this file only fetches, writes, and reports.
 *
 * WRITE DISCIPLINE: this reads Pipeline_Proposals first, derives the next free
 * row, and writes an EXPLICIT range — it never issues a bare append. An append
 * lands wherever the API thinks the table ends, which is a different row from
 * "after the last data row" the moment the tab has a trailing blank, a stray
 * cell, or a filter applied. The cost of getting that wrong is silently
 * overwriting real rows, so the row number is computed from data we just read.
 * (The repo has no surviving comment about the Merges-tab incident this rule
 * comes from — searched; the principle is applied here regardless.)
 *
 * FAIL SOFT: PASS 4's job is cadence. A failure in opportunity detection warns
 * and returns zero proposals rather than aborting a run whose primary writes
 * already succeeded, matching this project's per-pass fail-soft rule.
 */

import { RANGES } from '../../config/constants.js';
import type { AttioClient } from '../../lib/attio.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { Logger } from '../../lib/logger.js';
import type { MasterIdIndex } from './load.js';
import { scanForOpportunities, toSheetRow, type PipelineProposal } from './opportunity-scan.js';

/**
 * The signal. Verified live 2026-08-17 through this client (not assumed from
 * the MCP connector's own filter grammar, which is DIFFERENT and returns
 * HTTP 400 `unknown_filter_attribute_slug` against the REST endpoint):
 * `{slug: {$contains: value}}` is the shape records/query accepts.
 */
export const OPPORTUNITY_FILTER = {
  last_interaction_outcome: { $contains: 'Opportunity Emerging' },
} as const;

/** Pipeline_Proposals col B, 0-based — Attio_Record_ID, the dedup key. */
const PROPOSAL_RECORD_ID_COL = 1;
const PROPOSAL_COLUMN_COUNT = 12; // A-L

export interface OpportunityStepResult {
  readonly candidates: number;
  readonly excludedOnPipeline: number;
  readonly excludedNoMasterId: number;
  readonly excludedSynthetic: number;
  readonly excludedAlreadyProposed: number;
  readonly proposed: number;
  readonly written: number;
  readonly proposalIds: readonly string[];
}

export async function runOpportunityScan(args: {
  readonly attio: AttioClient;
  readonly sheets: SheetsClient;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly runId: string;
  readonly pipelineRecordIds: ReadonlySet<string>;
  readonly master: MasterIdIndex;
  readonly warnings: string[];
  /** Injectable for tests; defaults to now. */
  readonly detectedAt?: string;
}): Promise<OpportunityStepResult> {
  const { attio, sheets, logger, dryRun, runId, pipelineRecordIds, master, warnings } = args;
  const empty: OpportunityStepResult = {
    candidates: 0, excludedOnPipeline: 0, excludedNoMasterId: 0, excludedSynthetic: 0,
    excludedAlreadyProposed: 0, proposed: 0, written: 0, proposalIds: [],
  };

  try {
    const people = await attio.queryPeople(OPPORTUNITY_FILTER);
    logger.info(`  candidates with an Opportunity Emerging signal : ${people.length}`);

    const existingRows = await sheets.read(RANGES.pipelineProposalsData);
    const existingProposalRecordIds = new Set(
      existingRows.map((r) => cell(r, PROPOSAL_RECORD_ID_COL)).filter((v) => v !== ''),
    );
    logger.info(`  existing Pipeline_Proposals rows              : ${existingRows.length}`);

    const scan = scanForOpportunities({
      people,
      pipelineRecordIds,
      master,
      existingProposalRecordIds,
      runId,
      detectedAt: args.detectedAt ?? new Date().toISOString(),
    });

    logger.info(
      `  excluded: ${scan.counts.excludedOnPipeline} on pipeline · ` +
        `${scan.counts.excludedNoMasterId} no Master_ID · ` +
        `${scan.counts.excludedSynthetic} synthetic · ` +
        `${scan.counts.excludedAlreadyProposed} already proposed`,
    );
    for (const e of scan.exclusions) {
      logger.info(`    – ${e.name || e.recordId}: ${e.rule} (${e.detail})`);
    }

    if (scan.proposals.length === 0) {
      logger.info('  no new proposals');
      return { ...scan.counts, written: 0, proposalIds: [] };
    }

    logger.info(`  NEW proposals: ${scan.proposals.length}`);
    for (const p of scan.proposals) {
      logger.info(`    + ${p.proposalId} ${p.contactName} (${p.bhcId}) — ${p.evidence.slice(0, 80)}`);
    }

    if (dryRun) {
      logger.info(`  DRY RUN: ${scan.proposals.length} proposal(s) computed, 0 written`);
      return { ...scan.counts, written: 0, proposalIds: scan.proposals.map((p) => p.proposalId) };
    }

    const written = await appendProposals(sheets, existingRows.length, scan.proposals, logger);
    if (written !== scan.proposals.length) {
      const w = `Pipeline_Proposals: expected to write ${scan.proposals.length} row(s), verified ${written}`;
      warnings.push(w);
      logger.warn(`  ${w}`);
    }
    return { ...scan.counts, written, proposalIds: scan.proposals.map((p) => p.proposalId) };
  } catch (e) {
    const w = `PASS 4f opportunity scan failed (non-blocking, cadence writes unaffected): ${String(e)}`;
    warnings.push(w);
    logger.warn(`  ${w}`);
    return empty;
  }
}

/**
 * Write to an explicit range starting at the first genuinely free row, then
 * read it back and confirm the proposal ids actually landed where intended.
 * Returns how many were VERIFIED present, not how many were sent.
 */
async function appendProposals(
  sheets: SheetsClient,
  existingRowCount: number,
  proposals: readonly PipelineProposal[],
  logger: Logger,
): Promise<number> {
  const firstRow = 2 + existingRowCount; // data starts at row 2
  const lastRow = firstRow + proposals.length - 1;
  const range = `Pipeline_Proposals!A${firstRow}:L${lastRow}`;

  const values = proposals.map((p) => {
    const row = toSheetRow(p);
    if (row.length !== PROPOSAL_COLUMN_COUNT) {
      throw new Error(`proposal row width ${row.length} != ${PROPOSAL_COLUMN_COUNT} — refusing to write a misaligned row`);
    }
    return row;
  });

  logger.info(`  writing ${proposals.length} row(s) to ${range}`);
  await sheets.update(range, values as unknown[][]);

  const back = await sheets.read(range);
  const landed = new Set(back.map((r) => cell(r, 0)).filter((v) => v !== ''));
  const verified = proposals.filter((p) => landed.has(p.proposalId)).length;
  logger.info(`  read-back verified ${verified}/${proposals.length} proposal id(s) present`);
  return verified;
}
