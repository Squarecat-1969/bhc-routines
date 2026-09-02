/**
 * Constants for the Contacts Triage routine.
 *
 * Deliberately a separate file from `constants.ts`: that one is transcribed
 * from routines/BHC_Late_Edition.md and is owned by the Late Edition spec.
 * This routine has its own build spec and its own tuning surface, and the two
 * must be free to drift. The only things imported across the line are the
 * owned-address lists, which are facts about Bobby, not about either routine.
 */

import { OWNED_DOMAINS, OWNED_EMAILS } from './constants.js';

export function makeTriageRunId(now: Date = new Date()): string {
  return `CONTACTS-TRIAGE-${now.getTime()}`;
}

// --- Sheets ranges ----------------------------------------------------------
//
// This routine writes to exactly two tabs and reads nothing else from Sheets.
// It never touches Contacts, Master_ID, Activity_Log, Tasks_Open, or any tab
// carrying a permanent record (hard constraint in the build spec).

/** 1-based column index -> A1 letters. 1->'A', 24->'X', 27->'AA'. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Contacts_Triage_Queue is 24 columns, A-X. See QUEUE_HEADER for the order. */
export const QUEUE_COLUMNS = 24;

/**
 * ALWAYS derive a write range's end column from QUEUE_COLUMNS — never hardcode
 * the letter.
 *
 * A live run on 2026-08-09 failed on exactly this: the columns went from 22 to
 * 24 when provenance_source and connection_strength were appended, but
 * writeQueue still built `A2:V{n}` by hand. Sheets rejected 24-wide rows into a
 * 22-wide range ("tried writing to column [W]") and the whole queue write
 * aborted. The range and the row width have one source of truth now.
 */
export const QUEUE_LAST_COLUMN = columnLetter(QUEUE_COLUMNS);

/** Contact_Exclusions is 7 columns, A-G. See EXCLUSIONS_HEADER. */
export const EXCLUSIONS_COLUMNS = 7;

export const TRIAGE_RANGES = {
  queueHeader: 'Contacts_Triage_Queue!A1:X1',
  queueData: 'Contacts_Triage_Queue!A2:X',
  queueWrite: 'Contacts_Triage_Queue!A2:X',
  exclusionsHeader: 'Contact_Exclusions!A1:G1',
  exclusionsData: 'Contact_Exclusions!A2:G',
  exclusionsAppend: 'Contact_Exclusions!A2:G',
  /**
   * STEP 1b reads Master_ID to find retired identities. Read-only — this
   * routine never writes to the identity registry.
   */
  masterId: 'Master_ID!A2:F',
} as const;

/**
 * Master_ID column order: A BHC_ID · B Full_Name · C Location · D Google_Row ·
 * E Attio_Record_ID · F Notes. Declared here rather than reaching into pass4's
 * loader, which skips blank-BHC_ID rows — exactly the rows STEP 1b needs.
 */
export const MASTER_ID_COLS = {
  bhcId: 0,
  fullName: 1,
  location: 2,
  googleRow: 3,
  attioRecordId: 4,
  notes: 5,
} as const;

/**
 * Column order for Contacts_Triage_Queue, exactly as listed in the build
 * spec's STEP 5. Aida's Contacts triage page reads this tab positionally, so
 * the order is a contract — append new columns at the end, never insert.
 */
export const QUEUE_HEADER = [
  'attio_record_id',
  'name',
  'primary_email',
  'company',
  'keeper_probability',
  'deterministic_score',
  'llm_score',
  'score_source',
  'clamped',
  'column',
  'has_name',
  'interaction_count',
  'interaction_span_days',
  'direction',
  'provenance_subject',
  'provenance_date',
  'provenance_recipients',
  'reason',
  'status',
  'skip_until',
  'first_seen',
  'last_scored',
  // Appended 2026-08-08 when scoring moved onto Attio's computed signals.
  // Appended, never inserted — Aida reads this tab positionally.
  'provenance_source',
  'connection_strength',
] as const;

export const EXCLUSIONS_HEADER = [
  'attio_record_id',
  'name',
  'email',
  'reason',
  'excluded_date',
  'recoverable',
  'source',
] as const;

/** 0-based column indices into a Contacts_Triage_Queue row. */
export const QUEUE_COLS = {
  attioRecordId: 0,
  name: 1,
  primaryEmail: 2,
  company: 3,
  keeperProbability: 4,
  deterministicScore: 5,
  llmScore: 6,
  scoreSource: 7,
  clamped: 8,
  column: 9,
  hasName: 10,
  interactionCount: 11,
  interactionSpanDays: 12,
  direction: 13,
  provenanceSubject: 14,
  provenanceDate: 15,
  provenanceRecipients: 16,
  reason: 17,
  status: 18,
  skipUntil: 19,
  firstSeen: 20,
  lastScored: 21,
  provenanceSource: 22,
  connectionStrength: 23,
} as const;

/** 0-based column indices into a Contact_Exclusions row. */
export const EXCLUSIONS_COLS = {
  attioRecordId: 0,
  name: 1,
  email: 2,
  reason: 3,
  excludedDate: 4,
  recoverable: 5,
  source: 6,
} as const;

// --- STEP 1: enumeration ------------------------------------------------------

/**
 * Attio's records/query page size. Enumeration walks every person record and
 * splits bridged/unbridged client-side rather than relying on a server-side
 * "is empty" filter, because the client-side split is the thing the spec's
 * cross-check actually needs to be independent of. See docs/contacts-triage-notes.md #1.
 */
export const PEOPLE_PAGE_SIZE = 500;

/** Runaway-loop backstop for offset pagination. 200 pages x 500 = 100k people. */
export const PEOPLE_MAX_PAGES = 200;

/** Build-spec expectation for run one ("Expect ~282"). Reported, never enforced. */
export const EXPECTED_UNBRIDGED = 282;

// --- STEP 2: hard excludes ----------------------------------------------------

/**
 * THE COMPROMISE COHORT. Stored as a predicate window, not a list of record
 * IDs, so it self-corrects if the cohort turns out to be 174 rather than 170
 * (build spec, STEP 2a). Half-open: [start, end).
 */
export const COMPROMISE_WINDOW_START_MS = Date.parse('2026-07-22T14:00:00Z');
export const COMPROMISE_WINDOW_END_MS = Date.parse('2026-07-22T14:02:00Z');
export const COMPROMISE_REASON = '2026-07-22 compromise blast';

/**
 * "If (a) doesn't land near 170, say so loudly — that's a signal the cohort
 * definition drifted." Anything outside 170 +/- 40 raises a warning. Wide on
 * purpose: the point is to catch a definition that has drifted to ~0 or ~600,
 * not to police a normal +/-10 wobble.
 */
export const COMPROMISE_EXPECTED = 170;
export const COMPROMISE_EXPECTED_TOLERANCE = 40;

/** Bobby's own addresses (STEP 2b) and TNB internal (2c) — same facts Late Edition uses. */
export const TRIAGE_OWNED_EMAILS = OWNED_EMAILS;
export const TRIAGE_INTERNAL_DOMAINS = OWNED_DOMAINS;

/** STEP 2d — unattended role / no-reply local parts, matched exactly (case-insensitive). */
export const ROLE_LOCAL_PARTS = [
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'orders',
  'support',
  'billing',
  'notifications',
  'alerts',
  'newsletter',
  'tickets',
  'claims',
] as const;

/**
 * STEP 2f — family. Personal contacts live in Bobby's personal directory;
 * this system is business.
 *
 * Matched against the SURNAME only, case-insensitively, as a substring of that
 * surname so hyphenated and double-barrelled forms are caught
 * ("Macintosh-Hougham"). Deliberately not matched against the full name — a
 * business contact named e.g. "Hougham" as a first name, or an unrelated
 * company token, should not be swept up.
 *
 * This rule only catches the obvious cases. In-laws and differently-named
 * relatives are the manual `source = bobby` path's job, which is the real
 * answer — see docs/contacts-triage-notes.md #18.
 */
export const FAMILY_SURNAME_TOKENS = ['hougham'] as const;

/** STEP 2d — `invitation-*@`. */
export const ROLE_LOCAL_PREFIXES = ['invitation-'] as const;

/** STEP 2d — `*-noreply@`. */
export const ROLE_LOCAL_SUFFIXES = ['-noreply', '-no-reply'] as const;

/**
 * STEP 2d — "bare subdomain senders like email.*, mail.*, notifications.*".
 *
 * Matched only when the domain has three or more labels, i.e. the token really
 * is a sending subdomain (`email.patagonia.com`) and not a whole second-level
 * domain that happens to start with the same word. Without that guard,
 * `mail.com` — a real consumer mailbox provider people actually use — would be
 * hard-excluded, and a hard exclude never becomes a card at all.
 */
export const SENDING_SUBDOMAIN_LABELS = ['email', 'mail', 'notifications'] as const;

/**
 * NOT a hard exclude — a scoring signal (STEP 3, "personal or company domain
 * rather than a generic sender"). These local parts reach a human eventually
 * but aren't a person; they cost points (-8, and forgo the +6 for a personal
 * address) rather than removing the card.
 *
 * That distinction is load-bearing here. `staffing@hammercreative.com` scored
 * 72 on the 2026-08-08 dry run and should not have — but Hammer Creative is a
 * real agency relationship (jacob.anderson@hammercreative.com appears on the
 * 2026-07-22 blast recipient list). One inbox is noise; the company is not.
 * Penalising the local part leaves every named human at that domain untouched,
 * which hard-excluding could not do.
 *
 * MATCHED AS THE WHOLE LOCAL PART, never as a substring: `talent` must not
 * catch `talentedpeople@realcompany.com`. Enforced by exact Set membership in
 * classifyLocalPart, and pinned by test.
 */
export const GENERIC_ROLE_LOCAL_PARTS = [
  'info',
  'hello',
  'hi',
  'team',
  'contact',
  'admin',
  'office',
  'hr',
  'careers',
  'jobs',
  'recruiting',
  // Added 2026-08-09 from the first dry run's sample review. `recruiting`,
  // `careers`, `jobs` and `hr` were already present; these two were the gap.
  'staffing',
  'talent',
  'sales',
  'marketing',
  'events',
  'press',
  'media',
  'feedback',
  'service',
  'services',
  'help',
  'accounts',
  'accounting',
  'invoices',
  'payments',
  'inbox',
  'mail',
  'email',
  'webmaster',
  'postmaster',
] as const;

/** Consumer mailbox providers — "personal" for the purposes of the local-part signal, but not a company domain. */
export const FREEMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'comcast.net',
  'sbcglobal.net',
  'verizon.net',
  'att.net',
] as const;

// --- STEP 3/5: banding --------------------------------------------------------

export const BAND_KEEPER_MIN = 75;
export const BAND_JUNK_MAX = 25;

// --- STEP 4: the LLM gate -----------------------------------------------------
//
// GATED ON EVIDENCE, NOT ON BAND POSITION (changed 2026-08-09 after the first
// --llm run). Of 40 calls made under the old 30-84 band rule, 36 returned a
// reason citing the ABSENCE of readable evidence, and only 4 of 40 crossed a
// band boundary. That mapped almost exactly onto the 8 contacts that had
// anything readable at all: both real upward moves (+26, +12) went to the two
// contacts carrying a summary or a subject line.
//
// The variable was never score position — it was whether there is anything for
// the model to read. So the rule is now:
//
//     call IF (subject OR meeting summary OR description is present)
//          AND score is within [LLM_SCORE_MIN, LLM_SCORE_MAX]
//
// The range is widened rather than narrowed. A contact at 88 with a rich
// meeting summary is exactly where the model is most decisive, and excluding
// it for landing in a confident-looking spot is the same mistake as calling on
// a 45 with nothing to read. Only the settled tails are skipped.

/** Inclusive score range. Outside this, a call cannot change the outcome enough to be worth it. */
export const LLM_SCORE_MIN = 15;
export const LLM_SCORE_MAX = 90;

/** The LLM's score replaces the deterministic one, clamped to deterministic +/- this. */
export const LLM_CLAMP_RANGE = 30;

/**
 * Same model family Late Edition's narrow calls use. One call per contact,
 * fixed JSON schema, no tools, no conversation.
 */
export const TRIAGE_MODEL = 'claude-sonnet-5';

/** The response is `{score, reason}` and nothing else — 400 is generous. */
export const TRIAGE_MAX_TOKENS = 400;

/** How many Step 4 calls run at once, and the pause between waves. */
export const LLM_CONCURRENCY = 5;
export const LLM_WAVE_PAUSE_MS = 500;

/**
 * Cost backstop. Run one is expected to make 50-60 calls; a run that wants to
 * make 500 has found a bug in the banding, not 500 real ambiguous contacts.
 * Contacts past the cap keep their deterministic score and are reported.
 */
export const LLM_MAX_CALLS = 250;

// --- Attio computed relationship signals (the PRIMARY signal) -----------------
//
// Message-level email metadata is permanently unavailable to a workspace API
// token — Attio exposes no Emails scope for tokens, only for OAuth apps
// authenticating as a member with a connected mailbox. What IS available under
// the Records scope is Attio's own computed connection strength: the result of
// the analysis, rather than the raw material for it. Better coverage, no LLM
// cost. See docs/contacts-triage-notes.md #15.

/** Attio slugs for the computed signals. All read-only, all under Records. */
export const CONNECTION_SLUGS = {
  strengthLabel: 'strongest_connection_strength',
  strengthLegacy: 'strongest_connection_strength_legacy',
  strengthUser: 'strongest_connection_user',
  lastInteractionAt: 'last_interaction_at',
  lastInteractionChannel: 'last_interaction_channel',
  lastInteractionDirection: 'last_interaction_direction',
  lastInteractionSubject: 'last_interaction_subject',
  lastMeetingSummary: 'last_meeting_summary',
  /**
   * Span comes from these, NOT from first_email_interaction /
   * last_email_interaction: measured live 2026-08-08, the email-specific pair
   * is 0% populated across the candidate set while these two are 100%.
   */
  firstInteraction: 'first_interaction',
  lastInteraction: 'last_interaction',
  company: 'company',
} as const;

export const STRENGTH_BANDS = ['Very weak', 'Weak', 'Good', 'Strong', 'Very strong'] as const;
export type StrengthBand = (typeof STRENGTH_BANDS)[number];

/**
 * Lower bounds for the legacy numeric, derived from live data rather than
 * invented: every label's observed numeric range was read off all 2,505
 * records and the boundaries fall cleanly at 5 / 15 / 30 / 45.
 *
 * The numeric is preferred over the label (it is the same measurement without
 * the lossy bucketing) but it CANNOT be used linearly — it is unbounded and
 * violently skewed, ranging 0.1 to 1820 with most mass below 5. Banding is
 * what makes it usable; the raw value is carried through for finer tuning.
 */
export const STRENGTH_LEGACY_LOWER_BOUNDS: ReadonlyArray<readonly [StrengthBand, number]> = [
  ['Very strong', 45],
  ['Strong', 30],
  ['Good', 15],
  ['Weak', 5],
  ['Very weak', 0],
];

/** How much of the last-meeting summary / description reaches the prompt and the card. */
export const PROVENANCE_TEXT_CHARS = 240;
export const SUMMARY_CHARS_IN_PROMPT = 400;

// --- Signal thresholds (STEP 3) -----------------------------------------------

/**
 * CLIENT-TEAM COHERENCE. Survives the rewire intact in principle — it was
 * always computed from email_addresses across the candidate set rather than
 * from message metadata — but its two corroborating gates (a reply somewhere
 * in the set, a span of at least a day) came from message metadata and are
 * gone. What remains is domain co-occurrence, so the signal is weaker evidence
 * than it was. See docs/contacts-triage-notes.md #16.
 */
export const CLIENT_TEAM_MIN_SAME_DOMAIN_PEOPLE = 2;

/**
 * Transactional subject patterns (STEP 3, negative signals). Matched
 * case-insensitively against `last_interaction_subject` — the only subject
 * line still reachable, and only 3% populated. Retained because when it does
 * fire it is decisive, not because it carries much of the model.
 */
export const TRANSACTIONAL_SUBJECT_PATTERNS: readonly RegExp[] = [
  /\border\s+(confirmation|confirmed|received|#\d+)/i,
  /\byour\s+order\b/i,
  /\breceipt\b/i,
  /\binvoice\b/i,
  /\bstatement\s+(is\s+)?(ready|available)\b/i,
  /\bhas\s+shipped\b/i,
  /\bshipping\s+(confirmation|update)\b/i,
  /\btracking\s+(number|info|information)\b/i,
  /\bout\s+for\s+delivery\b/i,
  /\bdelivery\s+(confirmation|update|notification)\b/i,
  /\bappointment\s+(reminder|confirmed|confirmation)\b/i,
  /\breminder:/i,
  /\b(take|complete)\s+(our|this|a)\s+survey\b/i,
  /\bhow\s+did\s+we\s+do\b/i,
  /\brate\s+your\s+(experience|order|visit)\b/i,
  /\bverify\s+your\s+(email|account|address)\b/i,
  /\bconfirm\s+your\s+(email|subscription)\b/i,
  /\bpassword\s+reset\b/i,
  /\breset\s+your\s+password\b/i,
  /\bsecurity\s+(code|alert)\b/i,
  /\byour\s+(subscription|membership|plan)\s+(will|has|is)\b/i,
  /\brenewal\s+(notice|reminder)\b/i,
  /\bpayment\s+(received|due|failed|confirmation)\b/i,
  /\bbooking\s+(confirmation|confirmed)\b/i,
  /\bitinerary\b/i,
  /\be-?ticket\b/i,
  /\bwelcome\s+to\s+\w+/i,
  /\bunsubscribe\b/i,
];
