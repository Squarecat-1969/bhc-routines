/**
 * Spec 2g: "Stamp the row. Append to Brain_Complete (A–AD)." A-U mirror
 * Thread_Staging A-U, with K/L/M/N/O/P/T/U overridden by enrichment content
 * (or noise defaults for a triaged/test-guard NO_ACTION row); then V (blank),
 * W Action_Required, X Response_Draft, Y Tasks_JSON, Z Write_Targets_JSON,
 * AA Slack_Message, AB Run_ID, AC Reply_Recipients_JSON, AD Reply_Mode.
 */

import type { ThreadStagingFullRow } from './types.js';
import type { EnrichmentResponse } from './enrich-schema.js';
import type { WriteTargets } from './write-targets.js';
import type { NoiseTag } from './types.js';
import { computeReplyMode, computeReplyRecipients } from './reply-recipients.js';
import { buildSlackBlock } from './slack-block.js';

export type BrainCompleteContent =
  | { readonly kind: 'noise'; readonly tag: NoiseTag }
  | { readonly kind: 'enriched'; readonly enrichment: EnrichmentResponse };

export interface BrainCompleteRowInput {
  readonly source: ThreadStagingFullRow;
  readonly content: BrainCompleteContent;
  readonly writeTargets: WriteTargets | null;
  readonly primaryEmail: string | null;
  readonly secondaryEmails: readonly string[];
  readonly contactNameForSlack: string | null;
  readonly slackIndex: number;
  readonly runId: string;
}

/** Result of assembling one row — the 30-column array, plus whether it should appear in tonight's Slack digest. */
export interface BrainCompleteRow {
  readonly values: readonly unknown[]; // exactly 30 entries, A-AD
  readonly slackBlock: string | null; // null for NO_ACTION rows (not actionable)
}

function noiseDefaults(tag: NoiseTag): Pick<
  EnrichmentResponse,
  'running_summary' | 'key_commitments' | 'personal_details_flag' | 'company_intel' | 'pipeline_signals' | 'brain_notes' | 'ready_to_archive'
> & { action_required: 'NO_ACTION' } {
  return {
    running_summary: '',
    key_commitments: '',
    personal_details_flag: false,
    company_intel: '',
    pipeline_signals: '',
    brain_notes: `filtered: ${tag}`,
    action_required: 'NO_ACTION',
    ready_to_archive: false,
  };
}

export function buildBrainCompleteRow(input: BrainCompleteRowInput): BrainCompleteRow {
  const { source, content, writeTargets, primaryEmail, secondaryEmails, contactNameForSlack, slackIndex, runId } = input;

  const enriched =
    content.kind === 'enriched'
      ? content.enrichment
      : { ...noiseDefaults(content.tag), response_draft: '', tasks: [] as EnrichmentResponse['tasks'] };

  const actionRequired = enriched.action_required;
  const isReplyNeeded = actionRequired === 'REPLY_NEEDED';
  const isActionable = actionRequired !== 'NO_ACTION';

  const responseDraft = content.kind === 'enriched' ? content.enrichment.response_draft : '';
  const tasksJson = content.kind === 'enriched' ? JSON.stringify(content.enrichment.tasks) : '[]';
  const writeTargetsJson = writeTargets ? JSON.stringify(writeTargets) : '';

  let replyRecipientsJson = '';
  let replyMode = '';
  if (isReplyNeeded && primaryEmail) {
    replyRecipientsJson = JSON.stringify(computeReplyRecipients(primaryEmail, secondaryEmails));
    replyMode = computeReplyMode(secondaryEmails);
  }

  let slackBlock: string | null = null;
  if (isActionable) {
    slackBlock = buildSlackBlock({
      index: slackIndex,
      contactName: contactNameForSlack,
      subject: source.subject,
      actionRequired,
      oneLineSummary: enriched.running_summary,
      responseDraft,
    });
  }

  // A-J, Q-S pass through unchanged from the source row. K/L/M/N/O/P/T/U are
  // the enriched columns. O (Thread_Status) is carried through, not enriched.
  const values: unknown[] = [
    source.threadId, // A
    source.bhcId, // B
    source.contactName, // C
    source.sourceMailbox, // D
    source.direction, // E
    source.subject, // F
    source.firstEmailDate, // G
    source.lastEmailDate, // H
    source.emailCount, // I
    source.rawEmailsJson, // J
    enriched.running_summary, // K
    enriched.key_commitments, // L
    enriched.personal_details_flag, // M
    enriched.company_intel, // N
    source.threadStatus, // O
    enriched.ready_to_archive, // P
    source.parentThreadId, // Q
    source.contactHistoryRowId, // R
    source.crmLastSynced, // S
    enriched.pipeline_signals, // T
    enriched.brain_notes, // U
    '', // V Brain_Complete flag — blank, Part D sets TRUE on resolve
    actionRequired, // W
    responseDraft, // X
    tasksJson, // Y
    writeTargetsJson, // Z
    slackBlock ?? '', // AA
    runId, // AB
    replyRecipientsJson, // AC
    replyMode, // AD
  ];

  return { values, slackBlock };
}
