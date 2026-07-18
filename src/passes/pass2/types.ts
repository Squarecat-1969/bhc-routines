export interface RawEmailMessage {
  readonly recordId: string;
  readonly emailMsgId: string;
  readonly receivedAt: string;
  readonly sourceMailbox: string;
  readonly direction: string;
  readonly senderName: string;
  readonly senderEmail: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  /** Emails extracted from the cc_list field — see parseCcList's own comment for the real shape. */
  readonly ccEmails: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly threadId: string;
}

export type ResolutionSource = 'CONTACTS' | 'ATTIO' | 'NEW_CANDIDATE' | 'UNRESOLVED';

export interface ResolvedContact {
  readonly email: string;
  readonly source: ResolutionSource;
  readonly bhcId: string | null;
  readonly googleRow: number | null;
  readonly attioRecordId: string | null;
  readonly location: string | null; // Master_ID Location, once cross-referenced
}

export type DriftTag = 'drift:google-row-mismatch' | 'drift:attio-id-mismatch';

export interface DriftCheckResult {
  readonly clean: boolean;
  readonly tags: readonly DriftTag[];
  readonly notes: readonly string[];
}

export interface ParticipantResolution {
  readonly primary: ResolvedContact | null;
  readonly secondaries: readonly ResolvedContact[];
  readonly drift: DriftCheckResult;
}

export type NoiseTag =
  | 'noise:test'
  | 'noise:sensitive'
  | 'noise:automated'
  | 'noise:cold'
  | 'vendor';

export interface TriageResult {
  readonly isNoise: boolean;
  readonly tag: NoiseTag | null;
  readonly reason: string;
}

/**
 * Full Thread_Staging row (A-U, the columns Brain_Complete mirrors), plus
 * V/W (Row_Status/Run_ID, not mirrored but needed to mark the source
 * processed). Separate from pass1's narrower ThreadStagingRow — PASS 1 only
 * needed a subset; PASS 2 needs the full row to build Brain_Complete's A-U
 * passthrough columns. Duplication across passes is this codebase's stated
 * convention.
 */
export interface ThreadStagingFullRow {
  readonly threadId: string;
  readonly bhcId: string;
  readonly contactName: string;
  readonly sourceMailbox: string;
  readonly direction: string;
  readonly subject: string;
  readonly firstEmailDate: string;
  readonly lastEmailDate: string;
  readonly emailCount: string;
  readonly rawEmailsJson: string;
  readonly runningSummary: string;
  readonly keyCommitments: string;
  readonly personalDetailsFlag: string;
  readonly companyIntel: string;
  readonly threadStatus: string;
  readonly readyToArchive: string;
  readonly parentThreadId: string;
  readonly contactHistoryRowId: string;
  readonly crmLastSynced: string;
  readonly pipelineSignals: string;
  readonly brainNotes: string;
  readonly rowStatus: string;
  readonly runId: string;
  /** 1-based physical row in Thread_Staging (data starts at row 2). */
  readonly sheetRow: number;
}
