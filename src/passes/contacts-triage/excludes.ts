/**
 * STEP 2 — hard excludes. A hard exclude never becomes a card, never gets
 * scored, and is logged rather than shown.
 *
 * That asymmetry drives every judgment call in this file: a wrongly-excluded
 * contact disappears silently, while a wrongly-kept one merely costs Bobby one
 * junk card he can archive in a second. So every rule here is written to match
 * narrowly and be extended deliberately, never to generalize helpfully.
 *
 * RULE 2e IS GONE. "Records whose ONLY interaction is a hard bounce" requires
 * knowing the delivery status of every message to a contact — message
 * metadata, permanently unavailable to a workspace API token. There is no
 * approximation of it in Attio's computed signals, so it is removed rather
 * than faked. A bounce-only record now survives to be scored, where its Very
 * weak connection strength should put it in junk anyway. See
 * docs/contacts-triage-notes.md #15.
 */

import {
  COMPROMISE_REASON,
  FAMILY_SURNAME_TOKENS,
  COMPROMISE_WINDOW_END_MS,
  COMPROMISE_WINDOW_START_MS,
  ROLE_LOCAL_PARTS,
  ROLE_LOCAL_PREFIXES,
  ROLE_LOCAL_SUFFIXES,
  SENDING_SUBDOMAIN_LABELS,
  TRIAGE_INTERNAL_DOMAINS,
  TRIAGE_OWNED_EMAILS,
} from '../../config/triage-constants.js';
import type { Exclusion, UnbridgedContact } from './types.js';

export function localPartOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? email.toLowerCase() : email.slice(0, at).toLowerCase();
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/**
 * STEP 2a. A predicate over created_at, not a list of record IDs — so the
 * cohort is whatever the window actually contains on the day it runs.
 *
 * A record with no created_at is NOT in the cohort. The window is the entire
 * definition; without a timestamp there is nothing to test, and defaulting
 * either way would be a guess about ~170 records.
 */
export function isCompromiseCohort(createdAt: string | null): boolean {
  if (!createdAt) return false;
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return false;
  return ms >= COMPROMISE_WINDOW_START_MS && ms < COMPROMISE_WINDOW_END_MS;
}

/** STEP 2b. */
export function isOwnAddress(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (TRIAGE_OWNED_EMAILS as readonly string[]).includes(normalized);
}

/** STEP 2c — any address at an internal domain, not just Bobby's. */
export function isInternalDomain(email: string): boolean {
  const domain = domainOf(email);
  return (TRIAGE_INTERNAL_DOMAINS as readonly string[]).includes(domain);
}

/**
 * The surname from a display name.
 *
 * Handles the two forms Attio actually carries: "First Last" (last token) and
 * the inverted "Last, First" (everything before the comma). A single-token
 * name is treated as the surname, which is the safe reading — matching it
 * against the family list is better than skipping the check.
 */
export function surnameOf(name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return '';
  if (trimmed.includes(',')) return (trimmed.split(',')[0] ?? '').trim().toLowerCase();
  const tokens = trimmed.split(/\s+/).filter((t) => t !== '');
  return (tokens[tokens.length - 1] ?? '').toLowerCase();
}

/**
 * STEP 2f. Family — a category decision, not a scoring judgment.
 *
 * Jordan Macintosh-Hougham scored 87 on the 2026-08-09 dry run. That was not a
 * scoring failure: no deterministic signal distinguishes a close family
 * relationship from a strong professional one, and connection strength
 * actively rewards it. It belongs here with the other hard excludes.
 *
 * Substring match WITHIN the surname, so "Macintosh-Hougham" and "Hougham"
 * both match while a first name or company token does not.
 */
export function isFamilyName(name: string | null): boolean {
  const surname = surnameOf(name);
  if (surname === '') return false;
  return (FAMILY_SURNAME_TOKENS as readonly string[]).some((token) => surname.includes(token));
}

/**
 * STEP 2d. Local-part patterns plus bare sending subdomains.
 *
 * The subdomain rule requires three or more labels so `mail.com` (a real
 * consumer provider) isn't swept up by the `mail.*` pattern — see
 * SENDING_SUBDOMAIN_LABELS.
 */
export function isRoleAddress(email: string): boolean {
  const local = localPartOf(email);
  const domain = domainOf(email);

  if ((ROLE_LOCAL_PARTS as readonly string[]).includes(local)) return true;
  if (ROLE_LOCAL_PREFIXES.some((p) => local.startsWith(p))) return true;
  if (ROLE_LOCAL_SUFFIXES.some((s) => local.endsWith(s))) return true;

  const labels = domain.split('.').filter((l) => l !== '');
  if (labels.length >= 3) {
    const first = labels[0]!;
    if ((SENDING_SUBDOMAIN_LABELS as readonly string[]).includes(first)) return true;
  }

  return false;
}

/**
 * Rules a-d, in the spec's order. Returns null when the contact survives.
 *
 * Recoverable is a real distinction, not a formality. The compromise cohort is
 * explicitly RECOVERABLE — roughly 64% had genuine prior correspondence with
 * Bobby and are merely low-value, so a future pass can revisit them. Bobby's
 * own addresses, TNB internal staff, unattended role mailboxes and family are
 * not people to track in THIS CRM at all, under any later reconsideration —
 * family because personal contacts live in Bobby's personal directory, which
 * is a categorical decision rather than a low-value one. Flip family to
 * recoverable if a relative ever turns out to be a business contact too.
 */
export function classifyHardExclude(contact: UnbridgedContact): Exclusion | null {
  const base = {
    attioRecordId: contact.attioRecordId,
    name: contact.name ?? '',
    email: contact.primaryEmail ?? '',
    source: 'rule' as const,
  };

  if (isCompromiseCohort(contact.createdAt)) {
    return { ...base, reason: COMPROMISE_REASON, recoverable: true };
  }

  // Every address on the record is checked, not just the primary: a role
  // mailbox listed second is still a role mailbox.
  const emails = contact.allEmails.length > 0 ? contact.allEmails : contact.primaryEmail ? [contact.primaryEmail] : [];

  if (emails.some(isOwnAddress)) {
    return { ...base, reason: 'bobby own address', recoverable: false };
  }
  if (isFamilyName(contact.name)) {
    return { ...base, reason: 'family', recoverable: false };
  }
  if (emails.some(isInternalDomain)) {
    return { ...base, reason: 'thenewblank.com internal', recoverable: false };
  }
  if (emails.length > 0 && emails.every(isRoleAddress)) {
    return { ...base, reason: 'unattended role/no-reply address', recoverable: false };
  }

  return null;
}
