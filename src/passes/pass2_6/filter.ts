/**
 * The noise filter — measured, in order of cheapness.
 *
 * 37 of 72 August events are recurring occurrences (re-measured identical
 * 2026-09-01). All carry `seriesMasterId` and `type: "occurrence"`, so
 * recurrence is a reliable discriminator and no title heuristics are needed.
 *
 * ⚠ DO NOT FILTER ON `showAs`. `Lunch w Brian Johnson` is `showAs: "oof"` —
 * an availability test would discard a real business lunch. Verified live.
 *
 * ⚠ DO NOT FILTER ON THE `(personal)` SUFFIX. It marks CalendarBridge
 * provenance, not subject matter: `NICK B LAMB and Bobby Hougham (personal)`
 * is a real meeting with an insurance broker.
 *
 * Both of those are recorded as prohibitions rather than omissions because
 * each looks like an obvious cheap win to someone reading the data for the
 * first time, and each would silently drop the events that justify the source.
 */

import type { ExtractedParticipants } from './attendees.js';
import type { SafeCalendarEvent } from '../../lib/calendar.js';

/**
 * Addresses that are NOT external. "External" means not the company domain and
 * not one of Bobby's own addresses.
 *
 * ⚠ Bobby's personal gmail is here deliberately: it is the ORGANIZER address on
 * every CalendarBridge-synced event, so treating it as external would make
 * every path-2 event look like it had an outside participant and defeat rule 2.
 */
export const OWNED_DOMAINS: readonly string[] = ['thenewblank.com'];
export const OWNED_ADDRESSES: readonly string[] = ['bobbyhougham@gmail.com'];

export function isExternalAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a === '') return false;
  if (OWNED_ADDRESSES.includes(a)) return false;
  const domain = a.split('@')[1] ?? '';
  return !OWNED_DOMAINS.includes(domain);
}

export type DropReason = 'recurring_no_external' | 'no_external_participant' | 'cancelled';

export interface FilterOutcome {
  readonly keep: boolean;
  readonly reason: DropReason | null;
}

/**
 * ⚠ ORDER MATTERS AND IS NOT ARBITRARY. Rule 1 is first because it catches the
 * entire recurring-personal-block class in one test — `Lunch (personal)` alone
 * expands into 13 occurrences in a month.
 *
 * ⚠ Rule 1 requires BOTH conditions. A recurring occurrence WITH an external
 * participant is a real recurring business meeting and must survive — measured
 * 2026-09-01, several path-2 events are `type: "occurrence"` and carry outside
 * addresses. Dropping on recurrence alone would discard them.
 */
export function applyNoiseFilter(
  event: SafeCalendarEvent,
  participants: ExtractedParticipants,
): FilterOutcome {
  const hasExternal = participants.addresses.some(isExternalAddress);

  // 1 — recurring AND nobody outside.
  if (event.type === 'occurrence' && !hasExternal) {
    return { keep: false, reason: 'recurring_no_external' };
  }

  // 2 — nobody outside at all, after all three extraction paths.
  //
  // A path-3 event has no addresses by definition, so it cannot be judged on
  // them. It survives this rule and is decided by identity resolution instead:
  // if no known contact name appears in the subject it produces no verdict,
  // which is the same outcome by a route that cannot discard `Lunch w Brian
  // Johnson` — the single case that justifies the whole source.
  const subjectOnly = participants.addresses.length === 0 && participants.subject !== '';
  if (!hasExternal && !subjectOnly) {
    return { keep: false, reason: 'no_external_participant' };
  }

  // 3 — cancelled. A cancelled meeting is evidence of nothing.
  if (event.isCancelled) {
    return { keep: false, reason: 'cancelled' };
  }

  return { keep: true, reason: null };
}
