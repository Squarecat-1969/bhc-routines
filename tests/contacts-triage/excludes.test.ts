import { describe, expect, it } from 'vitest';

import {
  classifyHardExclude,
  isCompromiseCohort,
  isFamilyName,
  surnameOf,
  isInternalDomain,
  isOwnAddress,
  isRoleAddress,
} from '../../src/passes/contacts-triage/excludes.js';
import { contact as baseContact } from './fixtures.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';

function contact(overrides: Partial<UnbridgedContact> = {}): UnbridgedContact {
  return baseContact({ primaryEmail: 'jane@acme.com', allEmails: ['jane@acme.com'], company: 'Acme', createdAt: '2025-03-01T10:00:00Z', ...overrides });
}

describe('STEP 2a — the compromise cohort predicate', () => {
  it('matches inside the two-minute window', () => {
    expect(isCompromiseCohort('2026-07-22T14:00:00Z')).toBe(true);
    expect(isCompromiseCohort('2026-07-22T14:01:59.999Z')).toBe(true);
  });

  it('is half-open — the end instant is outside', () => {
    expect(isCompromiseCohort('2026-07-22T14:02:00Z')).toBe(false);
  });

  it('excludes a record one second before the window', () => {
    expect(isCompromiseCohort('2026-07-22T13:59:59Z')).toBe(false);
  });

  it('is a predicate, not a fixed count — it self-corrects if the cohort is larger than expected', () => {
    // 174 records inside the window all match; nothing about the rule caps at 170.
    const inside = Array.from({ length: 174 }, (_, i) =>
      new Date(Date.parse('2026-07-22T14:00:00Z') + i * 500).toISOString(),
    );
    expect(inside.filter(isCompromiseCohort)).toHaveLength(174);
  });

  it('never matches a record with no created_at — absence is not membership', () => {
    expect(isCompromiseCohort(null)).toBe(false);
    expect(isCompromiseCohort('not a date')).toBe(false);
  });

  it('is marked RECOVERABLE, not "not a person"', () => {
    const exclusion = classifyHardExclude(contact({ createdAt: '2026-07-22T14:00:30Z' }));
    expect(exclusion?.reason).toBe('2026-07-22 compromise blast');
    expect(exclusion?.recoverable).toBe(true);
  });
});

describe("STEP 2b/2c — Bobby's own addresses and TNB internal", () => {
  it('matches all three of his addresses, case-insensitively', () => {
    expect(isOwnAddress('bobby@hougham.us')).toBe(true);
    expect(isOwnAddress('BobbyHougham@Gmail.com')).toBe(true);
    expect(isOwnAddress('bobby@thenewblank.com')).toBe(true);
    expect(isOwnAddress('bobby@example.com')).toBe(false);
  });

  it('excludes any @thenewblank.com address, not just Bobby’s', () => {
    expect(isInternalDomain('someone.else@thenewblank.com')).toBe(true);
    expect(isInternalDomain('someone@notthenewblank.com')).toBe(false);
  });

  it('is not recoverable — these are never contacts to track', () => {
    expect(classifyHardExclude(contact({ primaryEmail: 'x@thenewblank.com', allEmails: ['x@thenewblank.com'] }))?.recoverable).toBe(false);
  });
});

describe('STEP 2d — unattended role and no-reply patterns', () => {
  it.each([
    'no-reply@shop.com',
    'noreply@shop.com',
    'donotreply@shop.com',
    'orders@shop.com',
    'support@shop.com',
    'billing@shop.com',
    'notifications@shop.com',
    'alerts@shop.com',
    'newsletter@shop.com',
    'tickets@shop.com',
    'claims@shop.com',
  ])('matches the exact role local part %s', (addr) => {
    expect(isRoleAddress(addr)).toBe(true);
  });

  it('matches invitation-* and *-noreply wildcards', () => {
    expect(isRoleAddress('invitation-12345@calendar.com')).toBe(true);
    expect(isRoleAddress('acme-noreply@acme.com')).toBe(true);
  });

  it('matches bare sending subdomains', () => {
    expect(isRoleAddress('hello@email.patagonia.com')).toBe(true);
    expect(isRoleAddress('hello@mail.notion.so')).toBe(true);
    expect(isRoleAddress('hello@notifications.github.com')).toBe(true);
  });

  it('does NOT sweep up mail.com — a real provider people actually use', () => {
    // The subdomain rule requires three or more labels. Without that guard a
    // real person at mail.com would be hard-excluded and never seen again.
    expect(isRoleAddress('jane.doe@mail.com')).toBe(false);
    expect(isRoleAddress('jane@email.com')).toBe(false);
  });

  it('leaves an ordinary person at a company alone', () => {
    expect(isRoleAddress('jane.doe@acme.com')).toBe(false);
    expect(isRoleAddress('jdoe@acme.co.uk')).toBe(false);
  });

  it('only excludes when EVERY address on the record is a role address', () => {
    const mixed = contact({
      primaryEmail: 'orders@shop.com',
      allEmails: ['orders@shop.com', 'jane.doe@shop.com'],
    });
    expect(classifyHardExclude(mixed)).toBeNull();
  });
});

describe('STEP 2f — family', () => {
  it('excludes the live case: Jordan Macintosh-Hougham, who scored 87', () => {
    const exclusion = classifyHardExclude(contact({ name: 'Jordan Macintosh-Hougham' }));
    expect(exclusion?.reason).toBe('family');
    expect(exclusion?.recoverable).toBe(false);
  });

  it('matches a plain surname and a hyphenated one, case-insensitively', () => {
    expect(isFamilyName('Jordan Macintosh-Hougham')).toBe(true);
    expect(isFamilyName('Someone HOUGHAM')).toBe(true);
    expect(isFamilyName('Hougham')).toBe(true);
  });

  it('handles the inverted "Last, First" form', () => {
    expect(surnameOf('Hougham, Jordan')).toBe('hougham');
    expect(isFamilyName('Hougham, Jordan')).toBe(true);
  });

  it('matches the SURNAME only — not a first name or a company token', () => {
    expect(isFamilyName('Hougham Smith')).toBe(false);
    expect(isFamilyName('Jane Doe')).toBe(false);
  });

  it('does not fire on a nameless record', () => {
    expect(isFamilyName(null)).toBe(false);
    expect(isFamilyName('')).toBe(false);
  });
});

describe('classifyHardExclude — rule precedence', () => {
  it('checks the compromise window before anything else', () => {
    const both = contact({
      createdAt: '2026-07-22T14:00:10Z',
      primaryEmail: 'orders@shop.com',
      allEmails: ['orders@shop.com'],
    });
    expect(classifyHardExclude(both)?.reason).toBe('2026-07-22 compromise blast');
  });

  it('returns null for a survivor', () => {
    expect(classifyHardExclude(contact())).toBeNull();
  });

  it('records the record id, name and email for the exclusions tab', () => {
    const exclusion = classifyHardExclude(
      contact({ attioRecordId: 'rec-9', name: 'Ops Bot', primaryEmail: 'support@vendor.com', allEmails: ['support@vendor.com'] }),
    );
    expect(exclusion).toMatchObject({
      attioRecordId: 'rec-9',
      name: 'Ops Bot',
      email: 'support@vendor.com',
      source: 'rule',
    });
  });
});
