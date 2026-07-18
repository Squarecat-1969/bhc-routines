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
