/**
 * CONTACTS TRIAGE — produces the queue Aida's Contacts triage page reads.
 *
 * It scores and stages. It never mints, never archives, never writes to Attio,
 * and touches exactly two Sheets tabs. Every verdict in the queue is a
 * proposal awaiting Bobby.
 *
 * Order of operations, and why:
 *   0. Tab preflight — the two tabs must exist and have the expected header
 *      before anything is computed, so a live run can't get all the way to a
 *      write and then discover it has nowhere valid to put it.
 *   1. Enumerate every unbridged person (STEP 1), cross-checked. Everything
 *      scoring needs arrives with this one walk.
 *   2. Hard excludes (STEP 2a-d) — the compromise cohort alone is ~60% of the
 *      unbridged population.
 *   3. Resolve company references, then score on Attio's computed signals
 *      (STEP 3). No per-contact fetch: consuming Attio's conclusion rather
 *      than the raw message metadata behind it is what makes this cheap.
 *   4. One narrow LLM call per contact in the 30-84 band (STEP 4).
 *   5. Merge against what's already in the tab and write (STEP 5/6).
 *   6. Report (STEP 7).
 *
 * STEP 2e (bounce-only exclusion) is GONE: it required knowing whether every
 * message to a contact hard-bounced, which is message metadata. Noted in
 * docs/contacts-triage-notes.md #15 rather than silently dropped.
 */

import {
  COMPROMISE_EXPECTED,
  COMPROMISE_EXPECTED_TOLERANCE,
  COMPROMISE_REASON,
  EXCLUSIONS_HEADER,
  LLM_CONCURRENCY,
  LLM_MAX_CALLS,
  LLM_WAVE_PAUSE_MS,
  QUEUE_COLUMNS,
  QUEUE_HEADER,
  QUEUE_LAST_COLUMN,
  TRIAGE_RANGES,
  makeTriageRunId,
} from '../../config/triage-constants.js';
import type { AnthropicClient } from '../../lib/anthropic.js';
import type { AttioClient } from '../../lib/attio.js';
import { todayIn, type CivilDate } from '../../lib/dates.js';
import { sleep } from '../../lib/http.js';
import type { Logger } from '../../lib/logger.js';
import { cell, type SheetsClient, type SheetRow } from '../../lib/sheets.js';
import { enumerateUnbridged } from './enumerate.js';
import { classifyHardExclude } from './excludes.js';
import { countByReason, matchExclusion, readExclusionIndex, serializeExclusion } from './exclusions.js';
import { isInLlmScoreRange, shouldCallLlm, scoreWithLlm } from './llm.js';
import { distributionOf, mergeQueue, parseExistingQueueRow } from './queue.js';
import { bandFor, scoreContact } from './score.js';
import { countByDomain, deriveSignals } from './signals.js';
import type {
  Exclusion,
  MergeAction,
  ScoredContact,
  TriageReport,
  UnbridgedContact,
} from './types.js';

export interface TriageOptions {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly attio: AttioClient;
  readonly sheets: SheetsClient;
  /** Omit to skip STEP 4 entirely (`--no-llm`); everything keeps its deterministic score. */
  readonly anthropic?: AnthropicClient;
  readonly logger: Logger;
  readonly today?: CivilDate;
  /** Cap on contacts scored — a dev convenience for a fast smoke test, not in the spec. */
  readonly limit?: number;
  readonly maxLlmCalls?: number;
}

class AbortRun extends Error {}

export async function runContactsTriage(opts: TriageOptions): Promise<TriageReport> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeTriageRunId();
  const today = opts.today ?? todayIn('UTC');

  try {
    return await runInner({ ...opts, runId, today, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    opts.logger.error(`Contacts triage aborted: ${message}`);
    return abortedReport(runId, today, opts.dryRun, startedAt, error instanceof AbortRun ? error.message : message);
  }
}

function abortedReport(
  runId: string,
  today: CivilDate,
  dryRun: boolean,
  startedAt: string,
  reason: string,
): TriageReport {
  const empty = distributionOf([]);
  return {
    runId,
    today,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: true,
    abortReason: reason,
    totalPeople: 0,
    bridgedCount: 0,
    unbridgedCount: 0,
    enumerationCrossCheck: 'unavailable',
    enumerationCrossCheckDetail: 'run aborted before or during enumeration',
    excludedByReason: {},
    exclusions: [],
    alreadyExcludedSkipped: 0,
    compromiseCohortCount: 0,
    compromiseCohortInRange: true,
    scored: [],
    deterministicDistribution: empty,
    finalDistribution: empty,
    llmEligible: 0,
    llmCallsMade: 0,
    llmFailures: 0,
    llmSkippedOverCap: 0,
    clampEvents: 0,
    strengthDistribution: {},
    strengthMissingCount: 0,
    noNameCount: 0,
    blankProvenanceCount: 0,
    provenanceSourceCounts: {},
    llmBandCount: 0,
    merged: [],
    mergeCounts: emptyMergeCounts(),
    queueRowsWritten: 0,
    exclusionsAppended: 0,
    readBackVerified: null,
    readBackDetail: '',
    warnings: [],
  };
}

function emptyMergeCounts(): Record<MergeAction, number> {
  return {
    new: 0,
    rescored: 0,
    'preserved-decision': 0,
    'preserved-skip': 0,
    'reactivated-skip-expired': 0,
    'reactivated-new-evidence': 0,
    'dropped-bridged': 0,
    'dropped-excluded': 0,
    'kept-unseen': 0,
  };
}

async function runInner(
  opts: TriageOptions & { runId: string; today: CivilDate; startedAt: string },
): Promise<TriageReport> {
  const { attio, sheets, logger, dryRun, runId, today, startedAt } = opts;
  const warnings: string[] = [];

  logger.info('CONTACTS TRIAGE');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes two staging tabs)'}`);
  logger.info(`  today  : ${today} (UTC)`);

  // --- STEP 0 — tab preflight -------------------------------------------------
  const preflight = await preflightTabs(sheets, logger, dryRun);
  warnings.push(...preflight.warnings);

  // --- STEP 1 — enumerate -----------------------------------------------------
  logger.info('STEP 1 — enumerating Attio people');
  const enumeration = await enumerateUnbridged(attio, logger);

  if (enumeration.duplicateIds.length > 0) {
    throw new AbortRun(
      `pagination returned ${enumeration.duplicateIds.length} duplicate record id(s) — the page order shifted mid-walk ` +
        'and the enumeration cannot be trusted. Re-run; if it repeats, lower PEOPLE_PAGE_SIZE.',
    );
  }
  if (enumeration.crossCheck === 'failed') {
    throw new AbortRun(`STEP 1 cross-check failed — ${enumeration.crossCheckDetail}`);
  }
  if (enumeration.crossCheck === 'unavailable') {
    warnings.push(`enumeration cross-check could not be run: ${enumeration.crossCheckDetail}`);
  }
  logger.info(
    `  ${enumeration.totalPeople} people, ${enumeration.bridgedIds.size} bridged, ${enumeration.unbridged.length} unbridged`,
  );

  // --- Prior exclusions -------------------------------------------------------
  const priorExclusionRows = preflight.exclusionsReadable ? await sheets.read(TRIAGE_RANGES.exclusionsData) : [];
  const exclusionIndex = readExclusionIndex(priorExclusionRows);
  logger.info(
    `  Contact_Exclusions: ${exclusionIndex.recordIds.size} record id(s), ${exclusionIndex.emails.size} email(s) already ruled on`,
  );
  if (exclusionIndex.unusableRows > 0) {
    const msg =
      `${exclusionIndex.unusableRows} Contact_Exclusions row(s) carry neither an attio_record_id nor an email — ` +
      'they can never match a contact. Add one or the other.';
    logger.warn(`  ${msg}`);
    warnings.push(msg);
  }

  // --- STEP 2a-d — hard excludes that need only the record ---------------------
  logger.info('STEP 2 — hard excludes');
  const exclusions: Exclusion[] = [];
  let alreadyExcludedSkipped = 0;
  let candidates: UnbridgedContact[] = [];

  // Record ids of contacts already ruled on, including those matched only by
  // email — the merge needs ids to drop their existing queue rows.
  const priorExcludedIds = new Set<string>(exclusionIndex.recordIds);
  let skippedByEmail = 0;

  for (const contact of enumeration.unbridged) {
    const match = matchExclusion(contact, exclusionIndex);
    if (match !== null) {
      alreadyExcludedSkipped += 1;
      if (match === 'email') {
        skippedByEmail += 1;
        priorExcludedIds.add(contact.attioRecordId);
      }
      continue;
    }
    const exclusion = classifyHardExclude(contact);
    if (exclusion) exclusions.push(exclusion);
    else candidates.push(contact);
  }
  if (alreadyExcludedSkipped > 0) {
    logger.info(
      `  ${alreadyExcludedSkipped} already ruled on and skipped (${skippedByEmail} matched by email, ` +
        `${alreadyExcludedSkipped - skippedByEmail} by record id)`,
    );
  }

  const compromiseCohortCount = exclusions.filter((e) => e.reason === COMPROMISE_REASON).length;
  const compromiseCohortInRange =
    Math.abs(compromiseCohortCount - COMPROMISE_EXPECTED) <= COMPROMISE_EXPECTED_TOLERANCE;
  if (!compromiseCohortInRange) {
    const msg =
      `COMPROMISE COHORT DRIFT: the ${COMPROMISE_REASON} window matched ${compromiseCohortCount} record(s), ` +
      `expected ~${COMPROMISE_EXPECTED}. The cohort definition may have drifted.`;
    logger.warn(`  ${msg}`);
    warnings.push(msg);
  }
  // Logged per-reason HERE, before the email fetch, rather than only in the
  // final report: a later abort (a bad email endpoint, say) would otherwise
  // discard perfectly good STEP 1 and STEP 2 findings, and those are the
  // numbers worth having even from a run that couldn't finish.
  const byReasonSoFar: Record<string, number> = {};
  for (const e of exclusions) byReasonSoFar[e.reason] = (byReasonSoFar[e.reason] ?? 0) + 1;
  for (const [reason, count] of Object.entries(byReasonSoFar).sort((a, b) => b[1] - a[1])) {
    logger.info(`  ${String(count).padStart(4, ' ')}  ${reason}`);
  }
  logger.info(`  ${exclusions.length} excluded, ${candidates.length} candidate(s) remain`);

  if (opts.limit !== undefined && opts.limit < candidates.length) {
    logger.info(`  --limit ${opts.limit} applied (of ${candidates.length} candidates)`);
    candidates = candidates.slice(0, opts.limit);
  }

  // --- Company names ----------------------------------------------------------
  // `company_name` is 0% populated; the `company` record reference resolves for
  // most candidates. One walk of the companies object, reused for the whole run.
  logger.info('STEP 3 — resolving company references');
  let companyNames = new Map<string, string>();
  try {
    companyNames = await attio.listCompanyNames();
    logger.info(`  ${companyNames.size} company name(s) available`);
  } catch (error) {
    const message = `company names could not be resolved (${error instanceof Error ? error.message : String(error)}) — the company column will be blank`;
    logger.warn(`  ${message}`);
    warnings.push(message);
  }

  const withCompany: UnbridgedContact[] = candidates.map((c) => ({
    ...c,
    company: c.company ?? (c.companyRecordId ? (companyNames.get(c.companyRecordId) ?? null) : null),
  }));

  // --- STEP 3 — score on Attio's computed signals ------------------------------
  // No per-contact fetch: everything scoring needs came back with the
  // enumeration walk. That is a direct consequence of consuming Attio's
  // computed conclusion rather than the raw message metadata behind it.
  logger.info(`  scoring ${withCompany.length} candidate(s) on Attio's computed signals`);
  const domainCounts = countByDomain(withCompany);
  const scored: ScoredContact[] = withCompany.map((contact) => {
    const signals = deriveSignals({ contact, domainCounts });
    const deterministic = scoreContact(signals);
    return {
      contact,
      signals,
      deterministic,
      llm: null,
      finalScore: deterministic.score,
      scoreSource: 'deterministic' as const,
      clamped: false,
      column: bandFor(deterministic.score),
      reason: deterministic.reason,
    };
  });

  const strengthMissingCount = scored.filter((s) => s.signals.strengthMissing).length;
  if (strengthMissingCount > 0) {
    warnings.push(
      `${strengthMissingCount} contact(s) have no connection strength computed by Attio — scored on identity and span alone`,
    );
  }

  const deterministicDistribution = distributionOf(scored.map((s) => s.deterministic.score));

  // --- STEP 4 — the LLM band --------------------------------------------------
  // Gated on EVIDENCE first, score range second — see llm.ts#shouldCallLlm.
  const eligible = scored.filter((s) => shouldCallLlm(s.signals, s.deterministic.score));
  const maxCalls = opts.maxLlmCalls ?? LLM_MAX_CALLS;
  let llmCallsMade = 0;
  let llmFailures = 0;
  let clampEvents = 0;
  let llmSkippedOverCap = 0;

  if (!opts.anthropic) {
    logger.info(`STEP 4 — skipped (no Anthropic client). ${eligible.length} contact(s) passed the evidence gate.`);
    if (eligible.length > 0) {
      warnings.push(`STEP 4 skipped — ${eligible.length} eligible contact(s) kept their deterministic score`);
    }
  } else {
    const toCall = eligible.slice(0, maxCalls);
    llmSkippedOverCap = eligible.length - toCall.length;
    if (llmSkippedOverCap > 0) {
      const msg = `STEP 4 cap of ${maxCalls} hit — ${llmSkippedOverCap} eligible contact(s) kept their deterministic score`;
      logger.warn(`  ${msg}`);
      warnings.push(msg);
    }
    logger.info(
      `STEP 4 — ${toCall.length} narrow LLM call(s): contacts with readable evidence, scored ${scored.filter((s) => isInLlmScoreRange(s.deterministic.score)).length} in range`,
    );

    const byId = new Map(scored.map((s, i) => [s.contact.attioRecordId, i]));

    for (let i = 0; i < toCall.length; i += LLM_CONCURRENCY) {
      const wave = toCall.slice(i, i + LLM_CONCURRENCY);
      const results = await Promise.all(
        wave.map((s) =>
          scoreWithLlm(opts.anthropic!, {
            contact: s.contact,
            signals: s.signals,
            deterministic: s.deterministic,
          }),
        ),
      );

      results.forEach((outcome, j) => {
        const base = wave[j]!;
        const index = byId.get(base.contact.attioRecordId)!;
        llmCallsMade += 1;

        if (!outcome.verdict) {
          llmFailures += 1;
          logger.warn(`  LLM failed for ${base.contact.attioRecordId}: ${outcome.error}`);
          scored[index] = {
            ...base,
            llm: outcome,
            scoreSource: 'deterministic-fallback',
            reason: `${base.deterministic.reason} [LLM unavailable: ${outcome.error}]`,
          };
          return;
        }

        if (outcome.clamped) clampEvents += 1;

        // A clamp means the two scorers disagreed by more than 30 points.
        // The build spec is explicit that this should surface as an Unclear
        // card rather than a confident verdict — so the band is forced, even
        // though the clamped score itself may land in keepers or junk.
        const column = outcome.clamped ? 'unclear' : bandFor(outcome.verdict.score);
        const clampNote = outcome.clamped
          ? ` [clamped from ${outcome.rawScore} to ${outcome.verdict.score}; deterministic said ${base.deterministic.score} — routed to unclear]`
          : '';

        scored[index] = {
          ...base,
          llm: outcome,
          finalScore: outcome.verdict.score,
          scoreSource: 'llm',
          clamped: outcome.clamped,
          column,
          reason: `${outcome.verdict.reason}${clampNote}`,
        };
      });

      if (i + LLM_CONCURRENCY < toCall.length) await sleep(LLM_WAVE_PAUSE_MS);
    }
  }

  const finalDistribution = distributionOf(scored.map((s) => s.finalScore));

  // --- STEP 5/6 — merge and write ---------------------------------------------
  logger.info('STEP 5 — merging against the existing queue');
  const existingRaw = preflight.queueReadable ? await sheets.read(TRIAGE_RANGES.queueData) : [];
  const existing = existingRaw
    .map(parseExistingQueueRow)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  logger.info(`  ${existing.length} existing row(s)`);

  const newExclusions = exclusions.filter((e) => !priorExcludedIds.has(e.attioRecordId));
  const excludedIds = new Set<string>([...priorExcludedIds, ...newExclusions.map((e) => e.attioRecordId)]);

  const merge = mergeQueue({
    scored,
    existing,
    bridgedIds: enumeration.bridgedIds,
    excludedIds,
    today,
  });
  warnings.push(...merge.warnings);

  const rowsToWrite = merge.rows.filter((r) => r.cells !== null).map((r) => r.cells as unknown[]);

  let readBackVerified: boolean | null = null;
  let readBackDetail = '';
  let exclusionsAppended = 0;

  if (dryRun) {
    logger.info(`  DRY RUN — would write ${rowsToWrite.length} queue row(s) and append ${newExclusions.length} exclusion(s)`);
  } else {
    logger.info(`  writing ${rowsToWrite.length} queue row(s)`);
    await writeQueue(sheets, rowsToWrite, existingRaw.length, logger);

    if (newExclusions.length > 0) {
      await sheets.append(
        TRIAGE_RANGES.exclusionsAppend,
        newExclusions.map((e) => serializeExclusion(e, today)),
      );
      exclusionsAppended = newExclusions.length;
      logger.info(`  appended ${exclusionsAppended} exclusion row(s)`);
    }

    const verification = await verifyWrite(sheets, rowsToWrite);
    readBackVerified = verification.ok;
    readBackDetail = verification.detail;
    if (!verification.ok) warnings.push(`read-back verification failed: ${verification.detail}`);
    logger.info(`  read-back: ${verification.ok ? 'verified' : 'FAILED'} — ${verification.detail}`);
  }

  const excludedByReason: Record<string, number> = {};
  for (const e of exclusions) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;

  // Coverage matters as much as discrimination, so these are first-class
  // report fields rather than something to be eyeballed from the rows.
  const strengthDistribution: Record<string, number> = {};
  const provenanceSourceCounts: Record<string, number> = {};
  for (const s of scored) {
    const band = s.signals.strength ?? '(empty)';
    strengthDistribution[band] = (strengthDistribution[band] ?? 0) + 1;
    const source = s.signals.provenance?.source ?? 'none';
    provenanceSourceCounts[source] = (provenanceSourceCounts[source] ?? 0) + 1;
  }
  const noNameCount = scored.filter((s) => !s.signals.hasName).length;
  const blankProvenanceCount = scored.filter((s) => s.signals.provenance === null).length;
  const llmBandCount = scored.filter((s) => isInLlmScoreRange(s.deterministic.score)).length;

  // Historical context: what prior runs already ruled on, so the Slack line
  // "excluded N" is never mistaken for the total ever excluded.
  const priorByReason = countByReason(priorExclusionRows);
  if (Object.keys(priorByReason).length > 0) {
    logger.info(`  prior exclusions by reason: ${JSON.stringify(priorByReason)}`);
  }

  return {
    runId,
    today,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    totalPeople: enumeration.totalPeople,
    bridgedCount: enumeration.bridgedIds.size,
    unbridgedCount: enumeration.unbridged.length,
    enumerationCrossCheck: enumeration.crossCheck,
    enumerationCrossCheckDetail: enumeration.crossCheckDetail,
    excludedByReason,
    exclusions,
    alreadyExcludedSkipped,
    compromiseCohortCount,
    compromiseCohortInRange,
    scored,
    deterministicDistribution,
    finalDistribution,
    llmEligible: eligible.length,
    llmCallsMade,
    llmFailures,
    llmSkippedOverCap,
    clampEvents,
    strengthDistribution,
    strengthMissingCount,
    noNameCount,
    blankProvenanceCount,
    provenanceSourceCounts,
    llmBandCount,
    merged: merge.rows,
    mergeCounts: merge.counts,
    queueRowsWritten: dryRun ? 0 : rowsToWrite.length,
    exclusionsAppended,
    readBackVerified,
    readBackDetail,
    warnings,
  };
}

// --- Tab preflight --------------------------------------------------------------

interface Preflight {
  readonly queueReadable: boolean;
  readonly exclusionsReadable: boolean;
  readonly warnings: readonly string[];
}

/**
 * Both tabs must exist with the expected header before anything else happens.
 *
 * The Sheets proxy can read, update and append — it cannot create a tab. So a
 * missing tab is a stop condition in live mode, reported clearly enough that
 * the fix ("create these two tabs with these headers") is obvious. A dry run
 * continues without them, because its whole job is to show the distribution
 * before anything is staged.
 */
async function preflightTabs(sheets: SheetsClient, logger: Logger, dryRun: boolean): Promise<Preflight> {
  const warnings: string[] = [];

  const check = async (
    range: string,
    expected: readonly string[],
    tab: string,
  ): Promise<boolean> => {
    let header: SheetRow[];
    try {
      header = await sheets.read(range, 'FORMATTED_VALUE');
    } catch (error) {
      const message = `${tab} tab is absent or unreadable (${error instanceof Error ? error.message : String(error)})`;
      if (!dryRun) {
        throw new AbortRun(
          `${message}. This routine cannot create tabs — create ${tab} with the header: ${expected.join(', ')}`,
        );
      }
      logger.warn(`  ${message} — dry run continues`);
      warnings.push(`${message} (dry run continued; a live run would stop here)`);
      return false;
    }

    const row = (header[0] ?? []).map((v) => String(v ?? '').trim());
    if (row.length === 0 || row.every((v) => v === '')) {
      if (!dryRun) {
        logger.info(`  ${tab} has no header row — writing it`);
        await sheets.update(range, [[...expected]]);
      } else {
        warnings.push(`${tab} has no header row (a live run would write it)`);
      }
      return true;
    }

    // A header that DISAGREES at some position is a different tab shape and is
    // never written into — Aida reads these tabs positionally. A header that
    // agrees as far as it goes but stops short is merely under-specified: the
    // real Contact_Exclusions tab was found live with its first five columns
    // correct and `recoverable`/`source` absent. Those two cases deserve
    // different answers.
    const overlap = Math.min(row.length, expected.length);
    for (let i = 0; i < overlap; i++) {
      if ((row[i] ?? '') !== expected[i]) {
        throw new AbortRun(
          `${tab} header disagrees at column ${i + 1}: expected "${expected[i]}", found "${row[i] ?? ''}". ` +
            `Full expected order: ${expected.join(', ')} — found: ${row.join(', ')}. ` +
            'Aida reads this tab positionally; refusing to write into a differently-shaped tab.',
        );
      }
    }

    if (row.length < expected.length) {
      const missing = expected.slice(row.length);
      if (!dryRun) {
        logger.info(`  ${tab} is missing trailing header(s) ${missing.join(', ')} — extending the header row`);
        await sheets.update(range, [[...expected]]);
      } else {
        warnings.push(
          `${tab} is missing trailing header(s): ${missing.join(', ')}. The existing columns are correct, so this ` +
            'is safe to extend; a live run would write the full header row.',
        );
      }
    } else if (row.length > expected.length) {
      // Extra trailing columns are somebody else's; our writes are scoped to
      // A:V / A:G and never reach them. Worth saying out loud, not worth stopping for.
      warnings.push(`${tab} has ${row.length - expected.length} column(s) beyond the expected header — left untouched`);
    }

    return true;
  };

  const queueReadable = await check(TRIAGE_RANGES.queueHeader, QUEUE_HEADER, 'Contacts_Triage_Queue');
  const exclusionsReadable = await check(TRIAGE_RANGES.exclusionsHeader, EXCLUSIONS_HEADER, 'Contact_Exclusions');

  return { queueReadable, exclusionsReadable, warnings };
}

// --- Write + verify ---------------------------------------------------------------

/**
 * Full rewrite of the queue block, then blank whatever the previous run left
 * below it. Same pattern PASS 4.5 uses on Pipeline_Cache, and for the same
 * reason: the Sheets proxy has no clear operation, so shrinking means writing
 * empty strings into the rows that are no longer used.
 *
 * The rewrite is safe for Bobby's decisions because the merge already
 * re-emitted every non-pending row from its own original cells.
 */
async function writeQueue(
  sheets: SheetsClient,
  rows: readonly unknown[][],
  priorRowCount: number,
  logger: Logger,
): Promise<void> {
  const newLastRow = 1 + rows.length;
  const priorLastRow = 1 + priorRowCount;

  // Fail locally, with a legible message, rather than letting Sheets reject the
  // batch with "tried writing to column [W]" after the run has already spent
  // its enumeration and its LLM calls.
  const wrong = rows.find((r) => r.length !== QUEUE_COLUMNS);
  if (wrong) {
    throw new AbortRun(
      `refusing to write a ${wrong.length}-column row into a ${QUEUE_COLUMNS}-column range — ` +
        'serializeQueueRow and QUEUE_COLUMNS have drifted apart',
    );
  }

  // WRITE-THEN-BLANK, DELIBERATELY UN-GATED. Reviewed 2026-08-30 during the
  // sweep that added freshness/confirmation gates to pass1's Brain_Complete
  // compaction and pass4_5's Pipeline_Cache, and deliberately NOT given the
  // same treatment. Recorded here because this is where a reader comparing the
  // three will be standing, and because the thing that justifies the omission
  // is ~200 lines away in the caller and invisible from this spot.
  //
  // THE SHAPE IS THE SAME. Write the survivors at the top, then blank the tail
  // they used to occupy. If the survivor write silently no-ops and the blank
  // proceeds, rows 2..newLastRow keep the OLD content while the tail, which
  // still held the real rows, is erased.
  //
  // WHAT STANDS IN FOR THE GATE. The caller runs verifyWrite immediately after
  // this function returns (see the `readBackVerified` block in the live branch
  // of the main run): it re-reads Contacts_Triage_Queue, compares the written
  // IDs against what came back IN ORDER, and pushes a warning on any mismatch.
  //
  // THAT IS DETECTION AFTER THE BLANK, NOT PREVENTION — genuinely weaker than
  // the gate pass1 and pass4_5 now have. By the time verifyWrite disagrees,
  // the tail is already gone. This is a real difference, not a wash.
  //
  // WHY IT IS ACCEPTED ANYWAY. Two reasons, and both are load-bearing:
  //   1. Contacts_Triage_Queue is rebuilt from scratch every run, so a
  //      corrupted queue self-repairs on the next pass with no human input.
  //   2. The failure is SURFACED rather than silent — it reaches `warnings`
  //      and the log — so it cannot sit unnoticed the way Part D's withheld
  //      writes did for a month.
  //
  // ⚠ THE CONDITION UNDER WHICH THIS DECISION EXPIRES. If EITHER of those
  // stops being true, this needs the gate:
  //   · the queue stops being rebuilt from scratch each run (a merge-in-place,
  //     an incremental update, or anything that makes a row's only copy live
  //     here), or
  //   · verifyWrite's result stops reaching a human — dropped from `warnings`,
  //     demoted to a log line nobody reads, or removed.
  // Named explicitly so a future change to the rebuild behaviour cannot
  // silently leave this justification standing after it has stopped holding.
  if (rows.length > 0) {
    await sheets.update(`Contacts_Triage_Queue!A2:${QUEUE_LAST_COLUMN}${newLastRow}`, rows);
  }

  if (priorLastRow > newLastRow) {
    const blankCount = priorLastRow - newLastRow;
    const blank = new Array(QUEUE_COLUMNS).fill('');
    await sheets.update(
      `Contacts_Triage_Queue!A${newLastRow + 1}:${QUEUE_LAST_COLUMN}${priorLastRow}`,
      Array.from({ length: blankCount }, () => blank),
    );
    logger.info(`  blanked ${blankCount} trailing row(s) from the previous run`);
  }
}

/** Read the queue back and confirm the write actually landed, in the order written. */
async function verifyWrite(
  sheets: SheetsClient,
  written: readonly unknown[][],
): Promise<{ ok: boolean; detail: string }> {
  const readBack = await sheets.read(TRIAGE_RANGES.queueData);
  const live = readBack.map((r) => cell(r, 0)).filter((id) => id !== '');
  const expected = written.map((r) => String(r[0] ?? ''));

  if (live.length !== expected.length) {
    return { ok: false, detail: `wrote ${expected.length} row(s), read back ${live.length}` };
  }
  const firstMismatch = expected.findIndex((id, i) => id !== live[i]);
  if (firstMismatch !== -1) {
    return {
      ok: false,
      detail: `row ${firstMismatch + 2} reads back as ${live[firstMismatch]}, expected ${expected[firstMismatch]}`,
    };
  }
  return { ok: true, detail: `${live.length} row(s) confirmed` };
}
