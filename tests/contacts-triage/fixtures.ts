/**
 * Shared fixture builder. One place that knows the shape of an
 * UnbridgedContact, so a change to Attio's signal set is a one-file edit
 * across the whole suite.
 */

import type { StrengthBand } from '../../src/config/triage-constants.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';

export const BOBBY = 'bobby@thenewblank.com';

export function contact(overrides: Partial<UnbridgedContact> = {}): UnbridgedContact {
  return {
    attioRecordId: 'rec-1',
    name: 'Jane Doe',
    primaryEmail: 'jane@dcsg.com',
    allEmails: ['jane@dcsg.com'],
    company: 'DCSG',
    companyRecordId: null,
    jobTitle: null,
    description: null,
    linkedin: null,
    createdAt: null,
    strengthLabel: null,
    strengthLegacy: null,
    firstInteractionAt: null,
    lastInteractionAt: null,
    lastInteractionChannel: null,
    lastInteractionDirection: null,
    lastInteractionSubject: null,
    lastMeetingSummary: null,
    ...overrides,
  };
}

/** A contact carrying a given strength band and a plausible legacy numeric. */
export function withStrength(band: StrengthBand, overrides: Partial<UnbridgedContact> = {}): UnbridgedContact {
  const legacy: Record<StrengthBand, number> = {
    'Very weak': 2.5,
    Weak: 9,
    Good: 20,
    Strong: 37,
    'Very strong': 60,
  };
  return contact({ strengthLabel: band, strengthLegacy: legacy[band], ...overrides });
}
