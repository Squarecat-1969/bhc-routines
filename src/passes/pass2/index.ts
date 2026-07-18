/**
 * PASS 2 — Enrichment (the core). Ties together every deterministic piece
 * plus the real enrichment call into one runnable pass over tonight's
 * working set.
 *
 * Per-thread flow:
 *   parse -> test-guard -> triage -> [real thread: resolve participants,
 *   drift-check, enrich via LLM] -> build Write_Targets -> build the
 *   Brain_Complete row -> append -> mark Thread_Staging PROCESSED.
 *
 * Fail-soft per thread, not per pass: an enrichment failure (bad API
 * response, malformed JSON) skips just that thread — it's left unprocessed
 * (Thread_Staging NOT marked PROCESSED) so it's naturally retried next run,
 * consistent with "when in doubt, leave it open" throughout this project.
 * The pass itself still wraps in the same fail-soft try/catch as every other
 * pass for a true systemic failure (Sheets/Attio down entirely).
 */

import { makeRunId } from '../../config/constants.js';
import type { AnthropicClient } from '../../lib/anthropic.js';
import type { AttioClient, AttioPersonRecord } from '../../lib/attio.js';
import type { Logger } from '../../lib/logger.js';
import type { SheetsClient } from '../../lib/sheets.js';
import { loadMasterId } from '../pass4/load.js';
import { buildContactContext } from './contact-context.js';
import { loadContactsEmailMap } from './contacts-email-map.js';
import { enrichThread } from './enrich.js';
import { isTestOrPlaceholder, identifyPrimaryAndSecondary } from './participants.js';
import { parseRawEmailsJson } from './parse-emails.js';
import { checkDrift, resolveContact } from './resolve.js';
import { triageContent } from './triage.js';
import { filterWorkingSet, loadThreadStagingFullRows } from './thread-staging-row.js';
import { buildBrainCompleteRow, type BrainCompleteContent } from './brain-complete-row.js';
import { buildWriteTargets, DIRECTION_VALUES, type DirectionValue, type PersonalContextExtract, type SecondaryTargetInput } from './write-targets.js';
import type { NoiseTag, ResolvedContact, ThreadStagingFullRow } from './types.js';

export interface Pass2Options {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly anthropic: AnthropicClient;
  readonly logger: Logger;
  /** Reuse PASS 1's already-computed working set instead of re-reading Thread_Staging. */
  readonly threadStagingWorkingSet?: readonly ThreadStagingFullRow[];
  /** Cap the number of threads processed — for a fast smoke test. Not in spec. */
  readonly limit?: number;
}

export interface ThreadPreview {
  readonly threadId: string;
  readonly contactName: string | null;
  readonly subject: string;
  readonly direction: string;
  readonly isNoise: boolean;
  readonly noiseTag: NoiseTag | null;
  readonly actionRequired: string | null;
  readonly outcome: string | null;
  readonly runningSummary: string | null;
  readonly keyCommitments: string | null;
  readonly responseDraft: string | null;
  readonly personalContextFound: boolean;
  readonly driftNotes: readonly string[];
}

export interface Pass2Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly workingSetCount: number;
  readonly processedCount: number;
  readonly writtenCount: number;
  readonly noiseCount: number;
  readonly enrichmentFailureCount: number;
  readonly actionableCount: number;
  readonly driftCount: number;

  /** One entry per successfully-processed thread — for reviewing actual content without going --live. */
  readonly previews: readonly ThreadPreview[];
  readonly warnings: readonly string[];
}

function emptyReport(partial: { runId: string; dryRun: boolean; startedAt: string; aborted?: boolean; abortReason?: string | null }): Pass2Report {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    workingSetCount: 0,
    processedCount: 0,
    writtenCount: 0,
    noiseCount: 0,
    enrichmentFailureCount: 0,
    actionableCount: 0,
    driftCount: 0,
    previews: [],
    warnings: [],
  };
}

function isDirectionValue(v: string): v is DirectionValue {
  return (DIRECTION_VALUES as readonly string[]).includes(v);
}

/** Never throws — same fail-soft posture as every other pass. */
export async function runPass2(opts: Pass2Options): Promise<Pass2Report> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeRunId();

  try {
    return await runPass2Inner({ ...opts, runId, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    opts.logger.warn(`PASS 2 aborted: ${message}`);
    return emptyReport({ runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function fetchAttioValuesIfNeeded(
  attio: AttioClient,
  resolved: ResolvedContact,
  cache: Map<string, AttioPersonRecord | null>,
): Promise<Record<string, unknown> | null> {
  if (!resolved.attioRecordId) return null;
  if (cache.has(resolved.attioRecordId)) return cache.get(resolved.attioRecordId)?.values ?? null;
  try {
    const record = await attio.getPersonRecord(resolved.attioRecordId);
    cache.set(resolved.attioRecordId, record);
    return record.values;
  } catch {
    cache.set(resolved.attioRecordId, null);
    return null;
  }
}

async function runPass2Inner(opts: Pass2Options & { runId: string; startedAt: string }): Promise<Pass2Report> {
  const { sheets, attio, anthropic, logger, dryRun, runId, startedAt } = opts;
  const warnings: string[] = [];

  logger.info('PASS 2 — Enrichment');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes to Sheets)'}`);

  logger.info('2.0 — loading Master_ID and Contacts email map');
  const masterIndex = await loadMasterId(sheets);
  const contactsMap = await loadContactsEmailMap(sheets, logger);

  logger.info('2.1 — loading Thread_Staging working set');
  let workingSet =
    opts.threadStagingWorkingSet ?? filterWorkingSet(await loadThreadStagingFullRows(sheets));
  logger.info(`  ${workingSet.length} thread(s) in tonight's working set`);
  if (opts.limit !== undefined && opts.limit < workingSet.length) {
    logger.info(`  --limit ${opts.limit} applied (of ${workingSet.length})`);
    workingSet = workingSet.slice(0, opts.limit);
  }

  const attioCache = new Map<string, AttioPersonRecord | null>();
  let processedCount = 0;
  let writtenCount = 0;
  let noiseCount = 0;
  let enrichmentFailureCount = 0;
  let actionableCount = 0;
  let driftCount = 0;
  let slackIndex = 0;
  const previews: ThreadPreview[] = [];

  for (const source of workingSet) {
    processedCount += 1;
    const messages = parseRawEmailsJson(source.rawEmailsJson);

    if (messages.length === 0) {
      warnings.push(`${source.threadId}: no parseable messages in Raw_Emails_JSON — skipped, left unprocessed`);
      continue;
    }

    let content: BrainCompleteContent;

    if (isTestOrPlaceholder(messages)) {
      content = { kind: 'noise', tag: 'noise:test' };
    } else {
      const triage = triageContent(messages);
      if (triage.isNoise) {
        content = { kind: 'noise', tag: triage.tag as NoiseTag };
      } else {
        // Real relationship thread — resolve participants and enrich.
        const { primaryEmail, secondaryEmails } = identifyPrimaryAndSecondary(messages, source.direction);
        let primaryResolved: ResolvedContact | null = null;
        let contactNameForSlack: string | null = null;

        if (primaryEmail) {
          primaryResolved = await resolveContact(primaryEmail, { contactsMap, masterIndex, attio });
          contactNameForSlack = source.contactName || primaryEmail;
        }
        const secondariesResolved = await Promise.all(
          secondaryEmails.map((email) => resolveContact(email, { contactsMap, masterIndex, attio })),
        );

        let attioValues: Record<string, unknown> | null = null;
        let primaryDrift: ReturnType<typeof checkDrift> = { clean: true, tags: [], notes: [] };
        if (primaryResolved) {
          attioValues = await fetchAttioValuesIfNeeded(attio, primaryResolved, attioCache);
          const contactsColA =
            primaryResolved.googleRow !== null ? (contactsMap.contactIdByGoogleRow.get(primaryResolved.googleRow) ?? null) : null;
          primaryDrift = checkDrift({ resolved: primaryResolved, contactsColAAtGoogleRow: contactsColA, attioRecordValues: attioValues });
          if (!primaryDrift.clean) {
            driftCount += 1;
            warnings.push(
              `${source.threadId}: identity drift on primary — ${primaryDrift.notes.join('; ')}. CRM writes withheld for the drifted side.`,
            );
          }
        }

        const contactContext = primaryResolved
          ? buildContactContext(primaryResolved, source.contactName, contactsMap, attioValues)
          : null;

        const outcome = await enrichThread(anthropic, messages, source.direction, contactContext);
        if (!outcome.ok) {
          enrichmentFailureCount += 1;
          warnings.push(
            `${source.threadId}: enrichment failed — ${outcome.error}. Left unprocessed for retry. ` +
              `Raw response tail: ${outcome.rawPreview}`,
          );
          continue;
        }
        warnings.push(...outcome.result.warnings.map((w) => `${source.threadId}: ${w}`));

        const enrichment = outcome.result.response;

        let writeTargets = null;
        if (primaryResolved?.bhcId) {
          const personalContext: PersonalContextExtract | null = enrichment.personal_details_flag
            ? {
                personalNotesExtract: enrichment.personal_notes_extract,
                topicsOfInterestExtract: enrichment.topics_of_interest_extract,
                conversationTriggerExtract: enrichment.conversation_trigger_extract,
              }
            : null;

          const secondaryInputs: SecondaryTargetInput[] = secondariesResolved
            .filter((r) => r.bhcId !== null)
            .map((resolved) => ({
              resolved,
              // Secondaries aren't explicitly drift-checked per spec (only "per
              // resolved contact" primary is spelled out) — conservative: assume
              // clean here, includeAttio's own Location check still gates the write.
              drift: { clean: true, tags: [], notes: [] },
              roleNote: `CC'd on thread: ${source.subject}`,
            }));

          writeTargets = buildWriteTargets(
            {
              resolved: primaryResolved,
              drift: primaryDrift,
              interaction: {
                date: (source.lastEmailDate || '').slice(0, 10),
                channel: 'Email',
                direction: isDirectionValue(source.direction) ? source.direction : 'Inbound',
                subject: source.subject,
                summary: enrichment.running_summary,
                outcome: enrichment.outcome,
                keyCommitments: enrichment.key_commitments,
              },
              personalContext,
            },
            secondaryInputs,
          );
        }

        content = { kind: 'enriched', enrichment };
        if (enrichment.action_required !== 'NO_ACTION') {
          slackIndex += 1;
          actionableCount += 1;
        }

        const row = buildBrainCompleteRow({
          source,
          content,
          writeTargets,
          primaryEmail,
          secondaryEmails,
          contactNameForSlack,
          slackIndex,
          runId,
        });

        if (!dryRun) {
          await sheets.append('Brain_Complete!A1', [row.values]);
          await sheets.update(`Thread_Staging!V${source.sheetRow}:W${source.sheetRow}`, [['PROCESSED', runId]]);
        }
        writtenCount += 1;
        previews.push({
          threadId: source.threadId,
          contactName: contactNameForSlack,
          subject: source.subject,
          direction: source.direction,
          isNoise: false,
          noiseTag: null,
          actionRequired: enrichment.action_required,
          outcome: enrichment.outcome,
          runningSummary: enrichment.running_summary,
          keyCommitments: enrichment.key_commitments,
          responseDraft: enrichment.action_required === 'REPLY_NEEDED' ? enrichment.response_draft : null,
          personalContextFound: enrichment.personal_details_flag,
          driftNotes: primaryDrift.notes,
        });
        continue;
      }
    }

    // Noise path (test-guard or triage) — no LLM call, minimal row.
    noiseCount += 1;
    const row = buildBrainCompleteRow({
      source,
      content,
      writeTargets: null,
      primaryEmail: null,
      secondaryEmails: [],
      contactNameForSlack: null,
      slackIndex: 0,
      runId,
    });
    if (!dryRun) {
      await sheets.append('Brain_Complete!A1', [row.values]);
      await sheets.update(`Thread_Staging!V${source.sheetRow}:W${source.sheetRow}`, [['PROCESSED', runId]]);
    }
    writtenCount += 1;
    previews.push({
      threadId: source.threadId,
      contactName: null,
      subject: source.subject,
      direction: source.direction,
      isNoise: true,
      noiseTag: content.kind === 'noise' ? content.tag : null,
      actionRequired: 'NO_ACTION',
      outcome: null,
      runningSummary: null,
      keyCommitments: null,
      responseDraft: null,
      personalContextFound: false,
      driftNotes: [],
    });
  }

  logger.info(
    `2.2 — done: processed=${processedCount} written=${writtenCount} noise=${noiseCount} ` +
      `enrichment_failures=${enrichmentFailureCount} actionable=${actionableCount} drift=${driftCount}`,
  );

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    workingSetCount: workingSet.length,
    processedCount,
    writtenCount,
    noiseCount,
    enrichmentFailureCount,
    actionableCount,
    driftCount,
    previews,
    warnings,
  };
}
