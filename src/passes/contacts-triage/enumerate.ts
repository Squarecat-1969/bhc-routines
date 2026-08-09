/**
 * STEP 1 — enumerate every Attio person record with no bhc_contact_id.
 *
 * "A silent under-enumeration is worse than no run." Two things follow from
 * that, and they are the whole design of this file:
 *
 *  1. The walk is exhaustive and client-side. Every person record is fetched
 *     and split into bridged/unbridged here, rather than asking Attio for
 *     "people where bhc_contact_id is empty". A server-side emptiness filter
 *     would make the count and the cross-check the same query asked twice.
 *
 *  2. The cross-check distinguishes "the numbers disagree" from "the check
 *     could not be run". The first is a stop condition. The second is a loud
 *     warning — refusing to run because an unverified filter operator isn't
 *     supported would be failing closed on the wrong signal.
 */

import {
  CONNECTION_SLUGS,
  PEOPLE_MAX_PAGES,
  PEOPLE_PAGE_SIZE,
  STRENGTH_LEGACY_LOWER_BOUNDS,
  type StrengthBand,
} from '../../config/triage-constants.js';
import { PERSON_SLUGS } from '../../config/constants.js';
import {
  dateOf,
  emailOf,
  emailsOf,
  nameOf,
  referenceIdOf,
  selectTitleOf,
  textOf,
  type AttioClient,
  type AttioPersonRecord,
  type AttioValues,
} from '../../lib/attio.js';
import type { Logger } from '../../lib/logger.js';
import type { UnbridgedContact } from './types.js';

/** Attio slug for the free-text description shown on a person card. */
const DESCRIPTION_SLUG = 'description';

/**
 * Band the legacy numeric using the live-derived boundaries. Preferred over
 * the select label because it is the same measurement without the bucketing
 * loss; the label is the fallback for the rare record carrying one without the
 * other.
 */
export function bandStrength(legacy: number | null, label: string | null): StrengthBand | null {
  if (legacy !== null && Number.isFinite(legacy)) {
    for (const [band, lowerBound] of STRENGTH_LEGACY_LOWER_BOUNDS) {
      if (legacy >= lowerBound) return band;
    }
  }
  const match = STRENGTH_LEGACY_LOWER_BOUNDS.find(([band]) => band === label);
  return match ? match[0] : null;
}

function numberOf(values: AttioValues | undefined, slug: string): number | null {
  const raw = textOf(values, slug);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function toUnbridgedContact(record: AttioPersonRecord): UnbridgedContact {
  const primary = emailOf(record.values, PERSON_SLUGS.emailAddresses);
  const legacy = numberOf(record.values, CONNECTION_SLUGS.strengthLegacy);
  const label = selectTitleOf(record.values, CONNECTION_SLUGS.strengthLabel);

  return {
    attioRecordId: record.recordId,
    name: nameOf(record.values, PERSON_SLUGS.name),
    primaryEmail: primary ? primary.toLowerCase() : null,
    allEmails: emailsOf(record.values, PERSON_SLUGS.emailAddresses),
    // Resolved later from the record reference — `company_name` is 0% populated.
    company: textOf(record.values, PERSON_SLUGS.companyName),
    companyRecordId: referenceIdOf(record.values, CONNECTION_SLUGS.company),
    jobTitle: textOf(record.values, PERSON_SLUGS.jobTitle),
    description: textOf(record.values, DESCRIPTION_SLUG),
    linkedin: textOf(record.values, PERSON_SLUGS.linkedin),
    createdAt: record.createdAt ?? null,

    strengthLabel: bandStrength(legacy, label),
    strengthLegacy: legacy,
    // first/last_interaction, NOT the *_email_interaction pair: measured live
    // at 100% and 0% coverage respectively across the candidate set.
    firstInteractionAt: dateOf(record.values, CONNECTION_SLUGS.firstInteraction),
    lastInteractionAt:
      dateOf(record.values, CONNECTION_SLUGS.lastInteraction) ??
      dateOf(record.values, CONNECTION_SLUGS.lastInteractionAt),
    lastInteractionChannel: selectTitleOf(record.values, CONNECTION_SLUGS.lastInteractionChannel),
    lastInteractionDirection: selectTitleOf(record.values, CONNECTION_SLUGS.lastInteractionDirection),
    lastInteractionSubject: textOf(record.values, CONNECTION_SLUGS.lastInteractionSubject),
    lastMeetingSummary: textOf(record.values, CONNECTION_SLUGS.lastMeetingSummary),
  };
}

export function hasBhcContactId(record: AttioPersonRecord): boolean {
  const value = textOf(record.values, PERSON_SLUGS.bhcContactId);
  return value !== null && value.trim() !== '';
}

/**
 * Longest common prefix of the bridged IDs the walk actually saw — 'BHC-' in
 * this workspace, but derived rather than hardcoded so the cross-check doesn't
 * quietly break the day the ID format changes.
 *
 * Returns null when there is nothing usable to filter on: no bridged records,
 * or IDs with no meaningful shared prefix. A too-short prefix would match
 * far more than intended and turn the cross-check into a false alarm.
 */
export function commonIdPrefix(ids: readonly string[], minLength = 2): string | null {
  if (ids.length === 0) return null;
  let prefix = ids[0]!;
  for (const id of ids.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < id.length && prefix[i] === id[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length < minLength) return null;
  }
  return prefix.length >= minLength ? prefix : null;
}

export interface EnumerationResult {
  readonly totalPeople: number;
  readonly bridgedIds: ReadonlySet<string>;
  readonly unbridged: readonly UnbridgedContact[];
  /** Records carrying the raw values, keyed by id — reused for the interaction-span fallback. */
  readonly recordsById: ReadonlyMap<string, AttioPersonRecord>;
  readonly crossCheck: 'passed' | 'failed' | 'unavailable';
  readonly crossCheckDetail: string;
  readonly duplicateIds: readonly string[];
}

export async function enumerateUnbridged(
  attio: AttioClient,
  logger: Logger,
  opts: { readonly pageSize?: number; readonly maxPages?: number } = {},
): Promise<EnumerationResult> {
  const { people, duplicateIds, pages } = await attio.listAllPeople({
    pageSize: opts.pageSize ?? PEOPLE_PAGE_SIZE,
    maxPages: opts.maxPages ?? PEOPLE_MAX_PAGES,
    onPage: (fetched) => logger.info(`  enumerated ${fetched} person record(s)`),
  });
  logger.info(`  ${people.length} person record(s) across ${pages} page(s)`);

  const bridgedIds = new Set<string>();
  const bridgedValues: string[] = [];
  const unbridged: UnbridgedContact[] = [];
  const recordsById = new Map<string, AttioPersonRecord>();

  for (const record of people) {
    recordsById.set(record.recordId, record);
    const bhcId = textOf(record.values, PERSON_SLUGS.bhcContactId);
    if (bhcId !== null && bhcId.trim() !== '') {
      bridgedIds.add(record.recordId);
      bridgedValues.push(bhcId.trim());
    } else {
      unbridged.push(toUnbridgedContact(record));
    }
  }

  const { crossCheck, crossCheckDetail } = await runCrossCheck(attio, logger, {
    totalPeople: people.length,
    bridgedCount: bridgedIds.size,
    unbridgedCount: unbridged.length,
    idPrefix: commonIdPrefix(bridgedValues),
  });

  return {
    totalPeople: people.length,
    bridgedIds,
    unbridged,
    recordsById,
    crossCheck,
    crossCheckDetail,
    duplicateIds,
  };
}

/**
 * Ask Attio directly how many people carry a bhc_contact_id, and check it
 * against the walk: enumerated == total - bridged.
 *
 * VERIFIED LIVE 2026-08-08: Attio rejects `$not_empty` on this field —
 * "Invalid operator \"$not_empty\" for field \"value\", must be one of
 * (\"$contains\", \"$ends_with\", \"$eq\", \"$in\", \"$starts_with\")". So the
 * check uses `$starts_with` against the longest common prefix of the IDs the
 * walk itself saw ('BHC-' here), which is a genuinely server-side count of the
 * same population and stays correct if the ID format ever changes.
 *
 * A thrown error means the check did not happen — reported as `unavailable`,
 * never as a pass.
 */
async function runCrossCheck(
  attio: AttioClient,
  logger: Logger,
  counts: { totalPeople: number; bridgedCount: number; unbridgedCount: number; idPrefix: string | null },
): Promise<{ crossCheck: EnumerationResult['crossCheck']; crossCheckDetail: string }> {
  if (counts.idPrefix === null) {
    const detail =
      counts.bridgedCount === 0
        ? 'no bridged records to cross-check against — every person in the workspace is unbridged'
        : 'bridged bhc_contact_id values share no usable common prefix, so no server-side filter can target them';
    logger.warn(`  cross-check skipped: ${detail}`);
    return { crossCheck: 'unavailable', crossCheckDetail: detail };
  }

  let serverBridged: number;
  try {
    serverBridged = await attio.countPeopleMatching({
      [PERSON_SLUGS.bhcContactId]: { $starts_with: counts.idPrefix },
    });
  } catch (error) {
    const detail =
      `cross-check could not be run (${error instanceof Error ? error.message : String(error)}) — ` +
      `enumeration stands on the full walk alone: ${counts.totalPeople} total, ` +
      `${counts.bridgedCount} bridged, ${counts.unbridgedCount} unbridged`;
    logger.warn(`  ${detail}`);
    return { crossCheck: 'unavailable', crossCheckDetail: detail };
  }

  const expected = counts.totalPeople - serverBridged;
  if (expected === counts.unbridgedCount) {
    return {
      crossCheck: 'passed',
      crossCheckDetail:
        `${counts.totalPeople} total - ${serverBridged} matching bhc_contact_id starts_with "${counts.idPrefix}" ` +
        `= ${expected} unbridged, matching the walk`,
    };
  }

  return {
    crossCheck: 'failed',
    crossCheckDetail:
      `enumeration disagrees with Attio's own count: walk found ${counts.unbridgedCount} unbridged ` +
      `(${counts.totalPeople} total - ${counts.bridgedCount} bridged), but a filtered query on ` +
      `bhc_contact_id starts_with "${counts.idPrefix}" counts ${serverBridged}, implying ${expected}`,
  };
}
