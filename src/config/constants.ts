/**
 * Constants transcribed from routines/BHC_Late_Edition.md. The spec is the
 * authority; if it changes, change it there first, then here.
 */

export const GOOGLE_CRM_SHEET_ID = '1R_6tDwAO1OUzBcd5JyAbJmUmY2JnbOc-MBIChNnEPlw';
export const ATTIO_PIPELINE_LIST = '3f3adbf0-e965-4b5f-8c52-2f77a4b832c9';
export const ATTIO_BOBBY_MEMBER_ID = '785d7b46-409e-4772-a342-193e0740275e';

export function makeRunId(now: Date = new Date()): string {
  return `LATE-EDITION-${now.getTime()}`;
}

// --- Cadence model (spec PASS 4) --------------------------------------------

export const TOUCH_MODES = ['Social', 'Context', 'Activation'] as const;
export type TouchMode = (typeof TOUCH_MODES)[number];

export const TRACKS = ['TNB', 'FTE', 'Fractional'] as const;
export type Track = (typeof TRACKS)[number];

export const TIERS = ['Core', 'Strategic', 'Peripheral'] as const;
export type Tier = (typeof TIERS)[number];

export interface CadenceRule {
  readonly days: number;
  readonly touchMode: TouchMode;
}

/** Stage-based cadence, used when active_stage_num >= 1. */
export const STAGE_CADENCE: Readonly<Record<number, CadenceRule>> = {
  1: { days: 4, touchMode: 'Context' },
  2: { days: 6, touchMode: 'Context' },
  3: { days: 8, touchMode: 'Activation' },
  4: { days: 4, touchMode: 'Activation' },
  5: { days: 90, touchMode: 'Social' },
};

export const MAX_KNOWN_STAGE = 5;

/** Tier-based cadence, used when every track is Stage 0 / blank. */
export const TIER_CADENCE: Readonly<Record<Tier, CadenceRule>> = {
  Core: { days: 45, touchMode: 'Context' },
  Strategic: { days: 90, touchMode: 'Social' },
  Peripheral: { days: 180, touchMode: 'Social' },
};

/**
 * Spec 4b ("Anything else → Strategic") and 4d (`tier_index.get(bhc_id, "Strategic")`)
 * both default an unknown tier to Strategic. The prose cadence table also lists a
 * separate "(unknown) → 90 days · Context" row, which disagrees on touch mode only
 * (both are 90 days). We follow the pseudocode. See docs/pass4-notes.md #2.
 */
export const DEFAULT_TIER: Tier = 'Strategic';

export const FOLLOW_UP_REASON_MAX_LEN = 500;

// --- Attio attribute slugs ---------------------------------------------------

export const PIPELINE_STAGE_SLUGS = {
  tnb: 'tnb_stage',
  fractional: 'fractional_stage',
  fte: 'fte_stage',
} as const;

export const PERSON_SLUGS = {
  name: 'name',
  bhcContactId: 'bhc_contact_id',
  lastInteractionAt: 'last_interaction',
  nextCheckInDate: 'next_check_in_date',
  nextTouchModePlanned: 'next_touch_mode_planned',
  followUpReason: 'follow_up_reason',
  // Added for PASS 4.5 (4.5b's per-record capture list).
  jobTitle: 'job_title',
  companyName: 'company_name',
  linkedin: 'linkedin',
  relationshipTier: 'relationship_tier',
  emailAddresses: 'email_addresses',
} as const;

// --- Sheets ranges -----------------------------------------------------------

export const RANGES = {
  masterId: 'Master_ID!A2:F',
  // The tier column sits well past V — the real Contacts tab has 113+ columns —
  // so read wide and resolve the tier column by header title, never by letter.
  // Header and data ranges must share the same start column (A) so a title's
  // index in the header row is the same index into each data row.
  contactsHeader: 'Contacts!A1:EZ1',
  contactsData: 'Contacts!A3:EZ',
  // PASS 4.5 targets.
  pipelineCacheHeader: 'Pipeline_Cache!A1:R1',
  pipelineCachePriorIds: 'Pipeline_Cache!A2:A',
  pipelineCacheWrite: 'Pipeline_Cache!A2:R',
  nameConflictsAll: 'Name_Conflicts!A2:M',
  nameConflictsAppend: 'Name_Conflicts!A2:M',
  // PASS 1 targets.
  brainCompleteData: 'Brain_Complete!A2:AD',
  threadStagingData: 'Thread_Staging!A2:W',
  // PASS 0 target.
  activityLogData: 'Activity_Log!A2:U',
  reconciliationQueueAll: 'Reconciliation_Queue!A2:N',
  reconciliationQueueAppend: 'Reconciliation_Queue!A2:N',
} as const;

/**
 * Activity_Log column indices (0-based) — verified live via
 * `npm run inspect:activity-log` (2026-07-18), NOT inferred from the spec's
 * bare "col J"/"col N"/"col P" references. See docs/pass1-and-pass0-notes.md.
 */
export const ACTIVITY_LOG_COLS = {
  activityId: 0, // A
  timestamp: 1, // B
  contactId: 2, // C
  contactName: 4, // E
  body: 9, // J
  outcome: 13, // N
  nextActionNote: 15, // P
} as const;

/**
 * PASS 1 column indices (0-based), per the spec's explicit A-W / A-AD schemas —
 * these ARE spec-verified, unlike Activity_Log's (see docs/pass1-notes.md).
 * Brain_Complete col V ("Brain_Complete" flag, Part D sets TRUE on resolve) is
 * the 22nd column, A=0 .. V=21. Thread_Staging col V (Row_Status) is also the
 * 22nd column of its own A-W range — same index, different sheet.
 */
export const BRAIN_COMPLETE_RESOLVED_COL = 21; // V
export const THREAD_STAGING_STATUS_COL = 21; // V
export const THREAD_STAGING_ROW_STATUS = { PENDING: 'PENDING', ACTIVE: 'ACTIVE', PROCESSED: 'PROCESSED' } as const;

/** Header titles accepted for the tier column, in preference order (spec 4b). */
export const TIER_HEADER_CANDIDATES = ['Relationship_Tier', 'Tier'] as const;

/** Contacts columns PASS 4.5 needs beyond tier — resolved by title, per spec 4.5b. */
export const CONTACTS_EMAIL_HEADER = 'Primary_Email';
export const CONTACTS_SEGMENT_HEADER = 'Effective_Segment';

/** Pipeline_Cache column order (spec 4.5e) — 18 columns, A-R. */
export const PIPELINE_CACHE_COLUMNS = 18;

/** Hardcoded per spec 4.5b — NEVER derived from hf_last_segment / hf_current_segment. */
export const ATTIO_SEGMENT_HARDCODE = 'S1';

/**
 * Owned/internal addresses (spec preamble) — a thread's contact is NEVER one
 * of these. OWNED_EMAILS is exact-match; OWNED_DOMAINS matches any address at
 * that domain (all of @thenewblank.com is internal TNB staff).
 */
export const OWNED_EMAILS = ['bobby@hougham.us', 'bobbyhougham@gmail.com', 'bobby@thenewblank.com'] as const;
export const OWNED_DOMAINS = ['thenewblank.com'] as const;

// --- Pacing (spec 4c: batches of 10, 2s between) ------------------------------

export const ATTIO_FETCH_BATCH_SIZE = 10;
export const ATTIO_FETCH_BATCH_PAUSE_MS = 2_000;

/**
 * PASS 4.5 fetches ~50x more records than PASS 4 (~2,213 vs ~44), so PASS 4's
 * pacing (tuned for its own scale) is far more conservative than necessary here.
 * These values are empirically proven, not guessed: three real dry runs against
 * production (2026-07-18) at batch=10/pause=2000ms, batch=25/pause=1000ms, and
 * batch=40/pause=1000ms all completed with zero failures and zero retries across
 * all 2,216 records. Wall time dropped from ~11m19s to ~2m15s. See
 * docs/pass4_5-notes.md #1 for the full comparison. Still overridable via
 * --batch-size/--pause-ms if headroom ever needs re-checking.
 */
export const PASS4_5_FETCH_BATCH_SIZE = 40;
export const PASS4_5_FETCH_PAUSE_MS = 1_000;
