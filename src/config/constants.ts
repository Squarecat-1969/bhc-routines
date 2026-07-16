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
  lastInteractionAt: 'last_interaction_at',
  nextCheckInDate: 'next_check_in_date',
  nextTouchModePlanned: 'next_touch_mode_planned',
  followUpReason: 'follow_up_reason',
} as const;

// --- Sheets ranges -----------------------------------------------------------

export const RANGES = {
  masterId: 'Master_ID!A2:F',
  contactsHeader: 'Contacts!A1:V1',
  contactsData: 'Contacts!A3:V',
} as const;

/** Header titles accepted for the tier column, in preference order (spec 4b). */
export const TIER_HEADER_CANDIDATES = ['Relationship_Tier', 'Tier'] as const;

// --- Pacing (spec 4c: batches of 10, 2s between) ------------------------------

export const ATTIO_FETCH_BATCH_SIZE = 10;
export const ATTIO_FETCH_BATCH_PAUSE_MS = 2_000;
