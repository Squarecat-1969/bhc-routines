/**
 * Pure PASS 0 logic — no I/O, testable without credentials.
 *
 * Two real unknowns flagged here rather than guessed past — see
 * docs/pass1-and-pass0-notes.md:
 *   1. Timestamp format across Activity_Log/Thread_Staging isn't live-verified
 *      the way Attio's slugs were. `parseTimestampMs` degrades to "can't
 *      determine window, don't match" rather than silently mismatching.
 *   2. "Contact" matching for the 72h-window fallback can't use Thread_Staging's
 *      BHC_ID column — it's blank until PASS 2 resolves it (spec's own note:
 *      "contact resolution is your job, not the Zap's"). Uses Contact_Name
 *      word-overlap instead (Zap C writes col C directly, no resolution
 *      needed), reusing the same significant-word logic as name verification
 *      elsewhere in this codebase — an inferred design choice, not spec text.
 */

import { significantWords } from '../../lib/name-verify.js';
import { ACTIVITY_LOG_COLS } from '../../config/constants.js';
import { cell } from '../../lib/sheets.js';
import type { ThreadStagingRow } from '../pass1/types.js';
import type { MatchResult, Placeholder } from './types.js';

const PENDING_CAPTURE_MARKER = '[PENDING_CAPTURE]';
const PENDING_CAPTURE_NOTE_RE = /PENDING_CAPTURE\s+thread:(\S+)/i;

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;
const STALE_PLACEHOLDER_DAYS = 7;

/** Activity_Log data starts at row 2 (row 1 is the header). */
const ACTIVITY_LOG_FIRST_ROW = 2;

/**
 * Best-effort timestamp parse. Tries ISO 8601 first, then whatever the
 * platform's Date constructor accepts (covers the observed "M/D/YYYY H:mm:ss"
 * shape) — but this format is NOT live-verified across all rows the way
 * Attio's slugs were, so an unparseable value returns null rather than a
 * guess, and callers must treat null as "can't determine, don't match."
 */
export function parseTimestampMs(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso.getTime();
  return null;
}

/**
 * Spec 4.4/PASS 0: "Read Activity_Log!A:U. Collect rows where col J starts
 * with [PENDING_CAPTURE] OR col P contains PENDING_CAPTURE thread:."
 */
export function findOpenPlaceholders(rows: readonly (readonly unknown[])[]): readonly Placeholder[] {
  const out: Placeholder[] = [];
  rows.forEach((row, i) => {
    const activityId = cell(row, ACTIVITY_LOG_COLS.activityId);
    if (activityId === '') return; // blank trailing row

    const body = cell(row, ACTIVITY_LOG_COLS.body);
    const note = cell(row, ACTIVITY_LOG_COLS.nextActionNote);
    const bodyFlag = body.startsWith(PENDING_CAPTURE_MARKER);
    const noteMatch = PENDING_CAPTURE_NOTE_RE.exec(note);

    if (!bodyFlag && !noteMatch) return;

    out.push({
      activityId,
      contactId: cell(row, ACTIVITY_LOG_COLS.contactId),
      contactName: cell(row, ACTIVITY_LOG_COLS.contactName),
      timestamp: cell(row, ACTIVITY_LOG_COLS.timestamp),
      threadIdFromNote: noteMatch?.[1] ?? '',
      sheetRow: ACTIVITY_LOG_FIRST_ROW + i,
    });
  });
  return out;
}

/** Spec: "col E = Outbound, or Bobby is sender." Only Direction is available pre-PASS2. */
export function findOutboundCandidates(workingSet: readonly ThreadStagingRow[]): readonly ThreadStagingRow[] {
  return workingSet.filter((r) => r.direction === 'Outbound');
}

/**
 * Match a single placeholder against tonight's outbound candidates.
 * Order: exact Thread_ID, then contact (name overlap) + 72h window, else
 * ambiguous (>1 candidate in the fallback) or no match.
 */
export function matchPlaceholder(
  placeholder: Placeholder,
  candidates: readonly ThreadStagingRow[],
): MatchResult {
  // 1. Exact Thread_ID match.
  if (placeholder.threadIdFromNote !== '') {
    const exact = candidates.find((c) => c.threadId === placeholder.threadIdFromNote);
    if (exact) {
      return {
        placeholder,
        verdict: 'EXACT',
        candidate: exact,
        ambiguousCandidates: [],
        reason: `Thread_ID exact match: ${exact.threadId}`,
      };
    }
  }

  // 2. Contact (name word-overlap) + 72h window fallback.
  const placeholderWords = significantWords(placeholder.contactName);
  const placeholderMs = parseTimestampMs(placeholder.timestamp);

  if (placeholderWords.size === 0 || placeholderMs === null) {
    return {
      placeholder,
      verdict: 'NO_MATCH',
      candidate: null,
      ambiguousCandidates: [],
      reason:
        placeholderWords.size === 0
          ? 'placeholder has no usable contact name for the fallback match'
          : `placeholder timestamp "${placeholder.timestamp}" could not be parsed`,
    };
  }

  const fallbackMatches = candidates.filter((c) => {
    const candidateWords = significantWords(c.contactName);
    const sharesWord = [...placeholderWords].some((w) => candidateWords.has(w));
    if (!sharesWord) return false;

    const candidateMs = parseTimestampMs(c.lastEmailDate);
    if (candidateMs === null) return false;
    return Math.abs(candidateMs - placeholderMs) <= SEVENTY_TWO_HOURS_MS;
  });

  if (fallbackMatches.length === 1) {
    return {
      placeholder,
      verdict: 'INFERRED',
      candidate: fallbackMatches[0]!,
      ambiguousCandidates: [],
      reason: `contact+72h window match: "${fallbackMatches[0]!.contactName}", thread "${fallbackMatches[0]!.subject}"`,
    };
  }

  if (fallbackMatches.length > 1) {
    return {
      placeholder,
      verdict: 'AMBIGUOUS',
      candidate: null,
      ambiguousCandidates: fallbackMatches,
      reason: `${fallbackMatches.length} candidate threads within the 72h window for this contact — ambiguous`,
    };
  }

  return {
    placeholder,
    verdict: 'NO_MATCH',
    candidate: null,
    ambiguousCandidates: [],
    reason: 'no Thread_ID, name, or 72h-window match found among tonight\'s outbound threads',
  };
}

/** Spec: "After 7 days: tag recon:stale-placeholder." */
export function isStalePlaceholder(placeholder: Placeholder, nowMs: number): boolean {
  const placeholderMs = parseTimestampMs(placeholder.timestamp);
  if (placeholderMs === null) return false; // can't determine age — don't guess
  const ageDays = (nowMs - placeholderMs) / (24 * 60 * 60 * 1000);
  return ageDays > STALE_PLACEHOLDER_DAYS;
}
