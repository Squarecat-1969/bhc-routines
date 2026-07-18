/**
 * Spec 2f: build Z Write_Targets_JSON. Pure assembly — this doesn't compute
 * the summary/outcome/commitments/personal-context content itself (that's
 * 2's LLM calls, not built yet); it takes that content as input and
 * assembles the exact shape Part D expects, enforcing every rule the spec
 * states about when fields are included or the whole thing is omitted.
 *
 * Column letters (BZ/CA/CB/CD/CE/CG) cross-checked against bhc-aida's own
 * commit/route.ts WRITABLE map (Bobby pasted that file earlier tonight for
 * the PASS 0 Reconciliation_Queue question) — same letters, same field
 * names. Not a guess.
 */

import type { DriftCheckResult, ResolvedContact } from './types.js';

export const CHANNEL_VALUES = ['LinkedIn DM', 'Email', 'Zoom', 'Phone', 'WhatsApp', 'iMessage', 'Slack', 'In Person'] as const;
export type ChannelValue = (typeof CHANNEL_VALUES)[number];

export const DIRECTION_VALUES = ['Outbound', 'Inbound', 'Internal'] as const;
export type DirectionValue = (typeof DIRECTION_VALUES)[number];

export const OUTCOME_VALUES = [
  'Positive',
  'Neutral',
  'No Response',
  'Negative',
  'Declined',
  'Opportunity Emerging',
  'Meeting Booked',
  'Advocate Signal',
  'Needs Nurture',
] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

export interface PersonalContextExtract {
  readonly personalNotesExtract: string;
  readonly topicsOfInterestExtract: string;
  readonly conversationTriggerExtract: string;
}

export interface InteractionContent {
  readonly date: string; // YYYY-MM-DD
  readonly channel: ChannelValue;
  readonly direction: DirectionValue;
  readonly subject: string;
  readonly summary: string; // 2-3 sentences for Google CE / Attio last_meeting_summary
  readonly outcome: OutcomeValue;
  readonly keyCommitments: string; // flat prose, never a participant-keyed object (spec's React #31 warning)
}

export interface PrimaryTargetInput {
  readonly resolved: ResolvedContact;
  readonly drift: DriftCheckResult;
  readonly interaction: InteractionContent;
  /** Only included in the output when personal_details_flag is true AND at least one field is non-empty. */
  readonly personalContext: PersonalContextExtract | null;
}

export interface SecondaryTargetInput {
  readonly resolved: ResolvedContact;
  readonly drift: DriftCheckResult;
  /** A short role note for Attio's last_meeting_summary — secondaries never get personal_context. */
  readonly roleNote: string;
}

export interface WriteTargetsGoogleBlock {
  readonly google_row: number;
  readonly fields: {
    readonly BZ: string;
    readonly CA: ChannelValue;
    readonly CB: DirectionValue;
    readonly CD: string;
    readonly CE: string;
    readonly CG: OutcomeValue;
  };
}

export interface WriteTargetsAttioBlock {
  readonly record_id: string;
  readonly fields: Record<string, string>;
}

export interface WriteTargetsPrimary {
  readonly bhc_id: string;
  readonly google?: WriteTargetsGoogleBlock;
  readonly attio?: WriteTargetsAttioBlock;
  readonly personal_context?: {
    readonly personal_notes_extract: string;
    readonly topics_of_interest_extract: string;
    readonly conversation_trigger_extract: string;
  };
}

export interface WriteTargetsSecondary {
  readonly bhc_id: string;
  readonly attio?: WriteTargetsAttioBlock;
}

export interface WriteTargets {
  readonly primary: WriteTargetsPrimary;
  readonly secondary: readonly WriteTargetsSecondary[];
}

function includeGoogle(resolved: ResolvedContact): boolean {
  return (resolved.location === 'GOOGLE' || resolved.location === 'BOTH') && resolved.googleRow !== null;
}

function includeAttio(resolved: ResolvedContact): boolean {
  return (resolved.location === 'ATTIO' || resolved.location === 'BOTH') && resolved.attioRecordId !== null;
}

/**
 * Build one primary target block, honoring drift withholding: a Google-side
 * mismatch withholds only the google block; an Attio-side mismatch withholds
 * only the attio block; the other side (if clean and applicable) still writes.
 */
function buildPrimary(input: PrimaryTargetInput): WriteTargetsPrimary {
  const { resolved, drift, interaction, personalContext } = input;
  const googleDrifted = drift.tags.includes('drift:google-row-mismatch');
  const attioDrifted = drift.tags.includes('drift:attio-id-mismatch');

  let primary: WriteTargetsPrimary = { bhc_id: resolved.bhcId! };

  if (includeGoogle(resolved) && !googleDrifted) {
    primary = {
      ...primary,
      google: {
        google_row: resolved.googleRow!,
        fields: {
          BZ: interaction.date,
          CA: interaction.channel,
          CB: interaction.direction,
          CD: interaction.subject,
          CE: interaction.summary,
          CG: interaction.outcome,
        },
      },
    };
  }

  if (includeAttio(resolved) && !attioDrifted) {
    primary = {
      ...primary,
      attio: {
        record_id: resolved.attioRecordId!,
        fields: { last_meeting_summary: interaction.summary, key_commitments: interaction.keyCommitments },
      },
    };
  }

  if (personalContext) {
    const { personalNotesExtract, topicsOfInterestExtract, conversationTriggerExtract } = personalContext;
    const allEmpty = personalNotesExtract === '' && topicsOfInterestExtract === '' && conversationTriggerExtract === '';
    if (!allEmpty) {
      primary = {
        ...primary,
        personal_context: {
          personal_notes_extract: personalNotesExtract,
          topics_of_interest_extract: topicsOfInterestExtract,
          conversation_trigger_extract: conversationTriggerExtract,
        },
      };
    }
  }

  return primary;
}

function buildSecondary(input: SecondaryTargetInput): WriteTargetsSecondary | null {
  const { resolved, drift, roleNote } = input;
  if (!resolved.bhcId) return null; // never write a secondary with no BHC_ID either
  const attioDrifted = drift.tags.includes('drift:attio-id-mismatch');

  if (includeAttio(resolved) && !attioDrifted) {
    return {
      bhc_id: resolved.bhcId,
      attio: { record_id: resolved.attioRecordId!, fields: { last_meeting_summary: roleNote } },
    };
  }
  return { bhc_id: resolved.bhcId };
}

/**
 * Spec: "If PRIMARY BHC_ID unresolved → omit Write_Targets entirely." Returns
 * null in that case — the caller should skip writing col Z at all, not write
 * an empty/null JSON value.
 */
export function buildWriteTargets(
  primaryInput: PrimaryTargetInput,
  secondaryInputs: readonly SecondaryTargetInput[] = [],
): WriteTargets | null {
  if (!primaryInput.resolved.bhcId) return null;

  const secondary = secondaryInputs
    .map(buildSecondary)
    .filter((s): s is WriteTargetsSecondary => s !== null);

  return { primary: buildPrimary(primaryInput), secondary };
}
