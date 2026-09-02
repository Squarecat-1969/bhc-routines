import type { CivilDate } from '../../lib/dates.js';
import type { Suppression } from './suppression.js';
import type { StrengthBand } from '../../config/triage-constants.js';

/** A person record with no bhc_contact_id — the raw material of every card. */
export interface UnbridgedContact {
  readonly attioRecordId: string;
  readonly name: string | null;
  readonly primaryEmail: string | null;
  /** Every address on the record, lowercased. */
  readonly allEmails: readonly string[];
  /** Resolved from the `company` record-reference — `company_name` is 0% populated. */
  readonly company: string | null;
  readonly companyRecordId: string | null;
  readonly jobTitle: string | null;
  readonly description: string | null;
  readonly linkedin: string | null;
  readonly createdAt: string | null;

  // --- Attio's computed relationship signals (Records scope) ---
  readonly strengthLabel: StrengthBand | null;
  readonly strengthLegacy: number | null;
  readonly firstInteractionAt: CivilDate | null;
  readonly lastInteractionAt: CivilDate | null;
  readonly lastInteractionChannel: string | null;
  /** Direction of the MOST RECENT interaction only — never a summary of the history. */
  readonly lastInteractionDirection: string | null;
  readonly lastInteractionSubject: string | null;
  readonly lastMeetingSummary: string | null;
}

export type ExclusionReason =
  | '2026-07-22 compromise blast'
  | 'bobby own address'
  | 'thenewblank.com internal'
  | 'unattended role/no-reply address'
  | 'family';

export interface Exclusion {
  readonly attioRecordId: string;
  readonly name: string;
  readonly email: string;
  readonly reason: ExclusionReason | string;
  readonly recoverable: boolean;
  /** 'rule' for anything this routine decides; 'bobby' rows are written by Aida. */
  readonly source: 'rule' | 'bobby';
}

/**
 * Direction of the most recent interaction, as Attio records it. This is NOT
 * the old two-way/one-way judgment — that required message-level metadata and
 * is gone. A single most-recent direction is a weak signal at most.
 */
export type LastDirection = 'inbound' | 'outbound' | 'internal' | 'unknown';

/** Everything STEP 3 scores on, derived once per contact. */
export interface ContactSignals {
  /** Attio's computed connection strength — the primary relationship signal. */
  readonly strength: StrengthBand | null;
  /** The raw legacy numeric behind the band. Unbounded and skewed; carried for tuning. */
  readonly strengthLegacy: number | null;
  /** True when Attio has computed no strength at all for this person. */
  readonly strengthMissing: boolean;

  readonly lastDirection: LastDirection;
  readonly lastChannel: string | null;

  readonly firstAt: CivilDate | null;
  readonly lastAt: CivilDate | null;
  readonly spanDays: number;
  /** False when the record carries no first/last interaction pair — span is unknown, not zero. */
  readonly spanKnown: boolean;

  readonly hasName: boolean;
  readonly hasLinkedin: boolean;
  /** A company resolved from the `company` record reference (or the text field). */
  readonly hasCompany: boolean;
  readonly localPart: 'personal' | 'generic-role' | 'opaque' | 'unknown';
  readonly domainKind: 'company' | 'freemail' | 'unknown';
  /**
   * Is there anything on this record for a model to actually READ — a subject
   * line, a meeting summary, or a description? This, not score position, is
   * what gates the STEP 4 call. A resolved company name does not count: it is
   * already an input to the deterministic score and tells a reader nothing new.
   */
  readonly hasReadableEvidence: boolean;

  readonly clientTeam: boolean;
  readonly clientTeamDomain: string | null;
  /** How many candidates in this run share the contact's non-freemail domain, including them. */
  readonly sameDomainCandidates: number;

  /** True only when a subject line exists AND matches a transactional pattern. */
  readonly transactionalSubject: boolean;
  /** True when the one available subject line is an auto-reply. */
  readonly lastSubjectIsAutoReply: boolean;

  readonly provenance: Provenance | null;
}

/**
 * The evidence line shown on the card. Degrades through the record's own
 * readable fields and is left BLANK rather than invented — see
 * docs/contacts-triage-notes.md #17.
 */
export type ProvenanceSource =
  | 'last-interaction-subject'
  | 'last-meeting-summary'
  | 'description'
  | 'role-and-company'
  | 'none';

export interface Provenance {
  readonly text: string;
  readonly date: CivilDate | null;
  readonly source: ProvenanceSource;
}

export interface ScoreContribution {
  readonly label: string;
  readonly delta: number;
}

export interface DeterministicScore {
  readonly score: number;
  readonly contributions: readonly ScoreContribution[];
  readonly reason: string;
}

export type ScoreSource = 'deterministic' | 'llm' | 'deterministic-fallback';
export type QueueColumn = 'keepers' | 'junk' | 'unclear';
export type QueueStatus = 'pending' | 'queued_keep' | 'queued_archive' | 'skipped' | 'processed';

export interface LlmVerdict {
  readonly score: number;
  readonly reason: string;
}

export interface LlmOutcome {
  readonly attioRecordId: string;
  readonly verdict: LlmVerdict | null;
  readonly error: string | null;
  /** True when the model's score fell outside deterministic +/- LLM_CLAMP_RANGE. */
  readonly clamped: boolean;
  /** What the model actually returned, before clamping — kept for tuning. */
  readonly rawScore: number | null;
}

/** A fully scored contact, before merge with what's already in the tab. */
export interface ScoredContact {
  readonly contact: UnbridgedContact;
  readonly signals: ContactSignals;
  readonly deterministic: DeterministicScore;
  readonly llm: LlmOutcome | null;
  readonly finalScore: number;
  readonly scoreSource: ScoreSource;
  readonly clamped: boolean;
  readonly column: QueueColumn;
  readonly reason: string;
}

/** One row of Contacts_Triage_Queue (24 columns, A-X). */
export interface QueueRow {
  readonly attioRecordId: string;
  readonly name: string;
  readonly primaryEmail: string;
  readonly company: string;
  readonly keeperProbability: number;
  readonly deterministicScore: number;
  readonly llmScore: number | null;
  readonly scoreSource: ScoreSource;
  readonly clamped: boolean;
  readonly column: QueueColumn;
  readonly hasName: boolean;
  /**
   * BLANK, always, since the rewire. A message count needs message metadata.
   * Writing 0 would assert "no interactions", which is false for every one of
   * these contacts — Attio's own interaction attributes are 100% populated.
   */
  readonly interactionCount: number | null;
  readonly interactionSpanDays: number | null;
  readonly direction: LastDirection;
  readonly provenanceSubject: string;
  readonly provenanceDate: string;
  /** BLANK since the rewire — recipient counts need message metadata. */
  readonly provenanceRecipients: number | null;
  readonly reason: string;
  readonly status: QueueStatus;
  readonly skipUntil: string;
  readonly firstSeen: string;
  readonly lastScored: string;
  readonly provenanceSource: ProvenanceSource;
  readonly connectionStrength: string;
}

/** An existing row, kept as raw cells so a non-pending row can be re-emitted byte-identical. */
export interface ExistingQueueRow {
  readonly attioRecordId: string;
  readonly cells: readonly unknown[];
  /**
   * The status cell exactly as read, not narrowed to QueueStatus. An
   * unrecognized value must not be coerced to "pending" — that would make a
   * typo in Bobby's column enough to overwrite his decision. The merge treats
   * anything it doesn't recognize as a decision to preserve.
   */
  readonly status: string;
  readonly column: QueueColumn;
  readonly keeperProbability: number;
  readonly skipUntil: string;
  readonly firstSeen: string;
  readonly lastScored: string;
}

/** What the merge decided for one row, and why — every outcome is reportable. */
export type MergeAction =
  | 'new'
  | 'rescored'
  | 'preserved-decision'
  | 'preserved-skip'
  | 'reactivated-skip-expired'
  | 'reactivated-new-evidence'
  | 'dropped-bridged'
  | 'dropped-excluded'
  | 'kept-unseen';

export interface MergedRow {
  readonly attioRecordId: string;
  readonly action: MergeAction;
  /** Serialized cells to write. Null for a dropped row. */
  readonly cells: readonly unknown[] | null;
  readonly column: QueueColumn;
  readonly keeperProbability: number;
}

export interface BandDistribution {
  readonly keepers: number;
  readonly unclear: number;
  readonly junk: number;
  /** 10-point buckets, index 0 = 0-9 ... index 10 = 100. Run one's tuning input. */
  readonly buckets: readonly number[];
}

export interface TriageReport {
  readonly runId: string;
  readonly today: CivilDate;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;

  readonly aborted: boolean;
  readonly abortReason: string | null;

  // STEP 1
  readonly totalPeople: number;
  readonly bridgedCount: number;
  readonly unbridgedCount: number;
  readonly enumerationCrossCheck: 'passed' | 'failed' | 'unavailable';
  readonly enumerationCrossCheckDetail: string;

  // STEP 1b — suppression against prior human decisions
  readonly suppressed: readonly Suppression[];
  readonly suppressedByKind: Readonly<Record<string, number>>;
  readonly supersededRowsSeen: number;
  readonly retiredIdentitiesIndexed: number;
  readonly mergeTombstonesIgnored: number;
  readonly activeSupersededRows: readonly number[];

  // STEP 2
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly exclusions: readonly Exclusion[];
  readonly alreadyExcludedSkipped: number;
  readonly compromiseCohortCount: number;
  readonly compromiseCohortInRange: boolean;

  // STEP 3/4
  readonly scored: readonly ScoredContact[];
  readonly deterministicDistribution: BandDistribution;
  readonly finalDistribution: BandDistribution;
  readonly llmEligible: number;
  readonly llmCallsMade: number;
  readonly llmFailures: number;
  readonly llmSkippedOverCap: number;
  readonly clampEvents: number;

  /** Coverage matters as much as discrimination — reported per band, with the empties. */
  readonly strengthDistribution: Readonly<Record<string, number>>;
  readonly strengthMissingCount: number;
  readonly noNameCount: number;
  readonly blankProvenanceCount: number;
  readonly provenanceSourceCounts: Readonly<Record<string, number>>;
  readonly llmBandCount: number;

  // STEP 5/6
  readonly merged: readonly MergedRow[];
  readonly mergeCounts: Readonly<Record<MergeAction, number>>;
  readonly queueRowsWritten: number;
  readonly exclusionsAppended: number;
  readonly readBackVerified: boolean | null;
  readonly readBackDetail: string;

  readonly warnings: readonly string[];
}
