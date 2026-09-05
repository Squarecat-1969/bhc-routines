/**
 * STEP 1c — DUPLICATE CANDIDATE DETECTION. Runs after suppression is computed
 * but over the FULL unbridged population, and it writes nothing.
 *
 * Step 1 stopped identities a human already retired from being re-queued.
 * This detects the other half: an unbridged Attio record that is the same
 * person as a record already bridged — or as another unbridged record.
 *
 * ⚠ IT SURFACES A QUESTION, NEVER A VERDICT. Measured live 2026-09-04, exact
 * full name against bridged records produces seven hits and THREE ARE WRONG:
 * two typo-domain records and a one-token name collision. Every candidate
 * carries a confidence and, more importantly, what DISTINGUISHES the two
 * records — a card optimised for confirming gets wrong answers confirmed.
 *
 * ⚠ DO NOT ADD AN EXACT-EMAIL SIGNAL. `email_addresses` is `is_unique: true`
 * on this workspace: Attio structurally cannot put one address on two person
 * records, so the signal returns zero by construction and always will. It
 * would pass every fixture test and find nothing forever. Same shape as
 * `last_email_interaction`, defined in the schema and populated on 0 of 2506
 * records. The measured table is in docs/attio-bridging-spec.md §4.
 *
 * ⚠ THE MATCH IS EXACT SET EQUALITY OVER SIGNIFICANT WORDS, NOT `verifyName`.
 * `verifyName` passes on ONE significant word in common, which is right for
 * verifying a pair a human proposed and wrong for generating them. Live proof,
 * from step 1: "Raymond Yang" (retired) and "Raymond Worsdale" (BHC-00679,
 * active at NBCUniversal) share `raymond`. `nameKeyOf` is reused from
 * suppression.ts verbatim so the two steps cannot drift about what a name is.
 *
 * ⚠ THE POLICY CHANGED 2026-09-04: TNB STAFF AND FORMER STAFF ARE CONTACTS,
 * tier Strategic. The owned-domain rule is a THREADING rule, not a
 * contact-eligibility rule. That is why detection runs over the full unbridged
 * set rather than over the post-exclusion candidates: the largest duplicate
 * cohort here is TNB staff on the Epic account carrying both a
 * @thenewblank.com and an @xa.epicgames.com address, and every one of them is
 * hard-excluded or already in Contact_Exclusions under the OLD policy. Filter
 * first and this step finds almost nothing — for a reason that is no longer
 * true. Zoe Cattolico (BHC-02386) is the worked example of the correct end
 * state, live: ONE record carrying BOTH addresses.
 *
 * So MERGE HERE CONSOLIDATES ADDRESSES onto one record. It is not the removal
 * of a redundant entry, and the card's wording has to say so.
 */

import { OWNED_DOMAINS, PERSON_SLUGS } from '../../config/constants.js';
import {
  FREEMAIL_DOMAINS,
  GENERIC_ROLE_LOCAL_PARTS,
  ROLE_LOCAL_PARTS,
} from '../../config/triage-constants.js';
import { textOf, type AttioPersonRecord } from '../../lib/attio.js';
import type { CivilDate } from '../../lib/dates.js';
import { domainOf, localPartOf } from './excludes.js';
import { toUnbridgedContact } from './enumerate.js';
import { nameKeyOf, type RetiredIdentity, type SuppressionIndex } from './suppression.js';
import type { UnbridgedContact } from './types.js';

/**
 * Read live from `GET /v2/self` on 2026-09-04. Only ever used to build a
 * human-clickable link, so a stale value is visible the first time someone
 * clicks it rather than silently wrong in the data.
 */
export const ATTIO_WORKSPACE_SLUG = 'tnb';

export function attioPersonUrl(recordId: string, slug = ATTIO_WORKSPACE_SLUG): string {
  return `https://app.attio.com/${slug}/person/${recordId}/overview`;
}

/**
 * A domain counts as CO-LOCATED with an owned domain once it has appeared
 * alongside one on at least this many distinct bridged records.
 *
 * Two, not one, because a single co-occurrence is a coincidence. Measured live
 * 2026-09-04 across 2255 bridged records, exactly one non-freemail domain
 * clears it: `xa.epicgames.com`, on 12 records. Everything else at 1 is a
 * personal domain on somebody's own record.
 */
export const COLOCATED_MIN_RECORDS = 2;

/**
 * A domain within this edit distance of an owned domain, but not equal to it,
 * is a typo domain. One, deliberately: `thenewblanks.com` is exactly one
 * insertion from `thenewblank.com`, and widening it to two starts matching
 * real unrelated domains.
 */
export const TYPO_DOMAIN_MAX_DISTANCE = 1;

/**
 * Below this length an edit distance of 1 is not evidence of anything —
 * `tnb.io` and `tnb.co` are one edit apart and unrelated. Unreachable with the
 * live owned list (nothing within one edit of `thenewblank.com` is this short),
 * so it is a forward guard, exercised by injecting a short owned domain rather
 * than asserted as a dead branch.
 */
export const TYPO_DOMAIN_MIN_LENGTH = 8;

/**
 * CRM-AS-REFERENCE typo radius. Wider than the owned-domain radius because the
 * evidence is stronger, not because the reference is weaker: the owned-domain
 * arm matches on the DOMAIN ALONE, so one edit is all it can safely allow,
 * while this arm additionally requires the LOCAL PART TO MATCH EXACTLY.
 *
 * Set to 2 per the addendum. Measured live 2026-09-04 the choice is free —
 * dropping it to 1 changes nothing, because every hit in this population is a
 * single edit. It is reported at both radii rather than assumed.
 */
export const CRM_TYPO_MAX_DISTANCE = 2;

export type DuplicateKind =
  /** An unbridged record that is the same person as a BRIDGED one. Merge consolidates addresses. */
  | 'merge-into-bridged'
  /** Two or more UNBRIDGED records that are one person. Neither carries a BHC_ID; mint once, not twice. */
  | 'consolidate-unbridged'
  /** Matches an ORPHAN CLEARED retired identity, whose annotation names the canonical BHC_ID. */
  | 'repoint'
  /** A near-miss on an owned domain: misaddressed mail Attio materialised into a person record. */
  | 'exclude-typo-domain';

export type DuplicateConfidence = 'high' | 'medium' | 'low';

/** One side of a candidate — bridged or not, extracted through ONE path so they cannot drift. */
export interface DuplicateSide {
  readonly attioRecordId: string;
  /** Null means unbridged. Non-null is the live `bhc_contact_id` value. */
  readonly bhcId: string | null;
  readonly name: string | null;
  readonly nameKey: string;
  readonly emails: readonly string[];
  readonly companyRecordId: string | null;
  readonly linkedin: string | null;
  readonly strength: string | null;
  readonly firstInteractionAt: CivilDate | null;
  readonly lastInteractionAt: CivilDate | null;
  readonly createdAt: string | null;
  readonly attioUrl: string;
}

export interface BridgedNameIndex {
  readonly byNameKey: ReadonlyMap<string, readonly DuplicateSide[]>;
  /**
   * Bridged records keyed by the EXACT lowercased local part of each address.
   * The reference set for CRM-as-reference typo detection.
   */
  readonly byEmailLocalPart: ReadonlyMap<string, readonly DuplicateSide[]>;
  /**
   * Every domain appearing on a bridged record — a domain a human has already
   * accepted. A domain in this set is never a typo of another one in it.
   */
  readonly bridgedDomains: ReadonlySet<string>;
  readonly bridgedCount: number;
  /** Bridged records whose name normalises to nothing — they can never match. */
  readonly unusableNameCount: number;
  /** Name keys held by more than one bridged record: two real people who share a name. */
  readonly ambiguousKeys: readonly string[];
  /** Non-freemail domains that share a bridged record with an owned-domain address. */
  readonly colocatedDomains: ReadonlySet<string>;
}

export interface DuplicateCandidate {
  readonly kind: DuplicateKind;
  readonly confidence: DuplicateConfidence;
  readonly nameKey: string;
  /** The unbridged record this candidate is about. One candidate per record — the queue's shape. */
  readonly subject: DuplicateSide;
  /** Bridged records matching the subject's name. */
  readonly bridgedMatches: readonly DuplicateSide[];
  /** Other UNBRIDGED records sharing the subject's name key. */
  readonly unbridgedSiblings: readonly DuplicateSide[];
  /** Near-misses on an owned domain — ground truth by definition. */
  readonly ownedDomainTypos: readonly TypoDomainHit[];
  /**
   * Near-misses on an address already on a BRIDGED record. Carries the
   * known-good address and the record holding it, which is what the card needs
   * to say "this should have been <reference>".
   */
  readonly crmTypos: readonly CrmTypoHit[];
  /** For a repoint: the BHC_ID the ORPHAN CLEARED annotation names, and the annotation itself. */
  readonly repointTo: string | null;
  readonly retiredMatches: readonly RetiredIdentity[];
  /** Signals that raised confidence. Never sufficient alone — the name is always the primary. */
  readonly corroboration: readonly string[];
  /** ⚠ What tells the two records APART. Rejection has to be as cheap as acceptance. */
  readonly distinguishing: readonly string[];
  /** Reasons to distrust the match, and the merge warnings from spec §5. */
  readonly cautions: readonly string[];
  /** What a human is being asked to do, worded for what a merge actually does here. */
  readonly proposedAction: string;
  /**
   * ⚠ WHY THIS CANDIDATE IS NOT IN THE QUEUE TODAY.
   *
   * A `Contact_Exclusions` row answers "should this become a NEW contact?".
   * It does not answer "is this address a missing address on an EXISTING
   * contact?" — those are different questions with different answers, and the
   * queue conflates them today. Recording the gate here is what lets step 3
   * decide which of the two it is asking, and lets a reviewer reject a
   * candidate as cheaply as accept it.
   */
  readonly gating: DuplicateGating;
}

export interface DuplicateGating {
  /** How STEP 1b suppressed this record, if it did. */
  readonly suppressedBy: string | null;
  /** The STEP 2 hard-exclude reason that would drop it, if any. */
  readonly hardExcludedBy: string | null;
}

export interface DuplicateDetection {
  readonly candidates: readonly DuplicateCandidate[];
  /** The headline the design rests on: unbridged records matching a bridged one by exact name. */
  readonly exactNameAgainstBridged: number;
  /** Name keys held by 2+ unbridged records, whether or not a bridged record also matches. */
  readonly unbridgedClusters: number;
  /** Records flagged by the owned-domain arm (ground truth). */
  readonly ownedTypoCandidates: number;
  /** Records flagged by the CRM-as-reference arm. */
  readonly crmTypoCandidates: number;
  /**
   * Records the CRM arm found that the owned-domain arm did NOT. Measured live
   * 2026-09-04: ZERO. Reported as a first-class number because the card design
   * rests on the size of this population, not on the mechanism finding it.
   */
  readonly crmTypoBeyondOwned: number;
  readonly byKind: Readonly<Record<DuplicateKind, number>>;
  readonly byConfidence: Readonly<Record<DuplicateConfidence, number>>;
  readonly colocatedDomains: readonly string[];
  readonly ambiguousBridgedKeys: readonly string[];
  readonly bridgedWithoutUsableName: number;
  readonly unbridgedWithoutUsableName: number;
  readonly singleTokenNameCandidates: number;
}

// --- extraction ---------------------------------------------------------------

function sideFrom(contact: UnbridgedContact, bhcId: string | null): DuplicateSide {
  return {
    attioRecordId: contact.attioRecordId,
    bhcId,
    name: contact.name,
    nameKey: nameKeyOf(contact.name),
    emails: contact.allEmails.length > 0
      ? contact.allEmails
      : contact.primaryEmail
        ? [contact.primaryEmail]
        : [],
    companyRecordId: contact.companyRecordId,
    linkedin: contact.linkedin,
    strength: contact.strengthLabel,
    firstInteractionAt: contact.firstInteractionAt,
    lastInteractionAt: contact.lastInteractionAt,
    createdAt: contact.createdAt,
    attioUrl: attioPersonUrl(contact.attioRecordId),
  };
}

/**
 * Both sides go through `toUnbridgedContact` — the same field extraction the
 * rest of the routine uses — so a bridged record and an unbridged one can
 * never be read differently. The only thing added is the BHC_ID.
 */
export function toDuplicateSide(record: AttioPersonRecord): DuplicateSide {
  const raw = textOf(record.values, PERSON_SLUGS.bhcContactId);
  const bhcId = raw !== null && raw.trim() !== '' ? raw.trim() : null;
  return sideFrom(toUnbridgedContact(record), bhcId);
}

export function unbridgedSide(contact: UnbridgedContact): DuplicateSide {
  return sideFrom(contact, null);
}

// --- small helpers ------------------------------------------------------------

/** `June.Yang+news@x` -> `juneyang`. Punctuation and plus-tags are not identity. */
export function normalizeLocalPart(email: string): string {
  const local = localPartOf(email).split('+')[0] ?? '';
  return local.replace(/[^a-z0-9]/g, '');
}

function isOwnedDomain(domain: string): boolean {
  return (OWNED_DOMAINS as readonly string[]).includes(domain);
}

function isFreemail(domain: string): boolean {
  return (FREEMAIL_DOMAINS as readonly string[]).includes(domain);
}

/**
 * `info@`, `sales@`, `support@` — matched as the WHOLE local part, never as a
 * substring, exactly as `classifyLocalPart` does. Reused from the scoring
 * constants rather than redeclared so the two cannot drift.
 */
function isGenericRoleLocalPart(local: string): boolean {
  return (
    (GENERIC_ROLE_LOCAL_PARTS as readonly string[]).includes(local) ||
    (ROLE_LOCAL_PARTS as readonly string[]).includes(local)
  );
}

/** Iterative Levenshtein. Small strings only; no early-exit cleverness needed. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export interface TypoDomainHit {
  readonly email: string;
  readonly domain: string;
  readonly nearest: string;
  readonly distance: number;
}

/**
 * A near-miss on an owned domain is evidence of MISADDRESSED MAIL, not of a
 * duplicate person — `chuck@thenewblanks.com` is mail intended for
 * `chuck@thenewblank.com` that Attio materialised into a person record. Those
 * are exclude candidates, and the equality guard is what keeps every genuine
 * `@thenewblank.com` staff address out of this bucket.
 */
export function typoDomainHits(
  emails: readonly string[],
  ownedDomains: readonly string[] = OWNED_DOMAINS,
): TypoDomainHit[] {
  const out: TypoDomainHit[] = [];
  for (const email of emails) {
    const domain = domainOf(email);
    if (domain === '') continue;
    // ⚠ AN OWNED DOMAIN IS NEVER ITS OWN TYPO. This is what keeps every
    // genuine @thenewblank.com staff address out of the exclude bucket — and
    // under the 2026-09-04 policy those people ARE contacts. It also matters
    // if OWNED_DOMAINS ever holds two similar domains, where one would
    // otherwise be read as a typo of the other.
    if (ownedDomains.includes(domain)) continue;

    for (const owned of ownedDomains) {
      // ⚠ ONE length floor, applied to the pair. Two separate floors — one on
      // each side — mutation-checked as mutually masking: neuter either and
      // the other still rejects the case, so neither was actually tested.
      if (Math.min(domain.length, owned.length) < TYPO_DOMAIN_MIN_LENGTH) continue;
      const distance = editDistance(domain, owned);
      if (distance <= TYPO_DOMAIN_MAX_DISTANCE) {
        out.push({ email, domain, nearest: owned, distance });
        break;
      }
    }
  }
  return out;
}

export interface CrmTypoHit {
  /** The unbridged record's address that looks like a typo. */
  readonly email: string;
  readonly domain: string;
  /** The address it is a near-miss of — known-good, because it is on a bridged record. */
  readonly referenceEmail: string;
  readonly referenceDomain: string;
  readonly distance: number;
  /** The bridged record carrying the known-good address. */
  readonly reference: DuplicateSide;
}

/**
 * CRM-AS-REFERENCE TYPO DETECTION.
 *
 * The owned-domain arm works only where there is ground truth: `thenewblank.com`
 * is known-correct by definition. For an external domain there is no such
 * reference — `raymond@epicgames.com` against `raymond@epicgame.com` is
 * undecidable on its own. **The CRM itself supplies the reference.** An address
 * already on a bridged record is one a human accepted and that has been used;
 * a near-variant of it arriving fresh from Attio's sync is a typo candidate.
 *
 * ⚠⚠ THE ASYMMETRY IS THE WHOLE DESIGN, AND IT IS NOT NEGOTIABLE.
 *
 *   SAME local part + NEAR-MISS DOMAIN  → almost certainly a typo.
 *       `chuck@thenewblank.com` vs `chuck@thenewblanks.com`. A domain is
 *       shared by many people, so an EXACT local-part match across a
 *       one-character domain difference is very unlikely to be two humans.
 *
 *   SAME domain + NEAR-MISS LOCAL PART  → almost certainly TWO PEOPLE.
 *       `jim@acme.com` and `tim@acme.com` are Levenshtein 1 and colleagues.
 *       `raymondy@` and `raymondz@` likewise.
 *
 * So the local part must match EXACTLY and only the domain may vary. Never the
 * reverse, and never both at once. Widening this to local-part variance is the
 * same failure mode as `verifyName`: a signal that looks symmetric and is not.
 * Two people at one company differing by a character is common; one person
 * with two near-identical domains is not.
 *
 * The guards, each of which is load-bearing and individually mutation-checked:
 *
 *  - **exact local part**, not normalised — see `buildBridgedNameIndex`.
 *  - **the domains must differ.** Equal domains mean equal addresses, which
 *    `is_unique: true` makes impossible anyway; the check is what makes the
 *    same-domain near-miss case return nothing rather than everything.
 *  - **the suspect domain must be UNKNOWN to the CRM.** If both domains appear
 *    on bridged records, both are known-good and neither is a typo of the
 *    other — the direct analogue of "an owned domain is never its own typo".
 *  - **no generic role local parts.** `info@`, `sales@`, `support@` are the
 *    one place an exact local-part match carries no identity at all, and the
 *    spec already records that this is how the local-part signal goes wrong.
 *  - **no freemail on either side.** `gmail.com` and `ymail.com` are one edit
 *    apart and are different providers used by different people, and `john` at
 *    each of them is two humans. This deliberately FORGOES genuine freemail
 *    typos (`john@gmai.com` for `john@gmail.com`) to avoid cross-provider
 *    collisions on common local parts in namespaces with millions of users.
 *    Revisit if a real freemail typo ever shows up; on a population of two,
 *    the conservative side is the right one.
 *  - **a length floor on the pair**, as for the owned-domain arm.
 */
export function crmTypoHits(emails: readonly string[], index: BridgedNameIndex): CrmTypoHit[] {
  const out: CrmTypoHit[] = [];

  for (const email of emails) {
    const domain = domainOf(email);
    const local = localPartOf(email);
    if (domain === '' || local === '') continue;

    // A domain already on a bridged record is known-good, not a suspect.
    if (index.bridgedDomains.has(domain)) continue;
    // Freemail near-misses are different providers, not typos of each other.
    if (isFreemail(domain)) continue;
    // A role mailbox's local part says nothing about who anybody is.
    if (isGenericRoleLocalPart(local)) continue;

    for (const reference of index.byEmailLocalPart.get(local) ?? []) {
      for (const referenceEmail of reference.emails) {
        if (localPartOf(referenceEmail) !== local) continue;
        const referenceDomain = domainOf(referenceEmail);
        // ⚠ NO blank-domain check and NO `referenceDomain === domain` check
        // here, DELIBERATELY. It reads
        // like it belongs, and it is unreachable: the reference is always a
        // bridged record, so its domain is always in `bridgedDomains`, and the
        // known-good-domain guard above has already skipped any suspect whose
        // domain is in that set. Mutation-checked as dead — neutering it
        // changed nothing, because the guard above rejects the case first.
        // A blank domain is likewise already rejected: `Math.min(_, 0)` is
        // below the length floor. Two guards for one job means neither is
        // tested; the floor and the known-good check are the ones that are.
        if (isFreemail(referenceDomain)) continue;
        if (Math.min(domain.length, referenceDomain.length) < TYPO_DOMAIN_MIN_LENGTH) continue;

        const distance = editDistance(domain, referenceDomain);
        if (distance > CRM_TYPO_MAX_DISTANCE) continue;

        out.push({ email, domain, referenceEmail, referenceDomain, distance, reference });
        break;
      }
    }
  }

  return out;
}

/** A one-word name key — "Le", "MOHAI". Matching on it is a collision waiting to happen. */
export function isSingleTokenKey(nameKey: string): boolean {
  return nameKey !== '' && !nameKey.includes(' ');
}

/**
 * The canonical BHC_ID an ORPHAN CLEARED annotation names.
 *
 * Verified live 2026-09-04: all 13 ORPHAN CLEARED rows name one in the leading
 * clause `leadAnnotation` already keeps ("duplicate of BHC-00293 (Ron Buse…)",
 * "Andrew Kobliska is BHC-01541 at Master_ID row 1572"). Returns null rather
 * than guessing when none is present — a repoint with no target is not a
 * repoint.
 */
export function canonicalBhcIdIn(annotation: string): string | null {
  const m = /\bBHC-\d{4,}\b/.exec(annotation);
  return m ? m[0] : null;
}

// --- the index ----------------------------------------------------------------

export function buildBridgedNameIndex(bridged: readonly DuplicateSide[]): BridgedNameIndex {
  const byNameKey = new Map<string, DuplicateSide[]>();
  const byEmailLocalPart = new Map<string, DuplicateSide[]>();
  const bridgedDomains = new Set<string>();
  let unusableNameCount = 0;

  for (const side of bridged) {
    // ⚠ THE REFERENCE SET IS BRIDGED RECORDS ONLY. An address on a bridged
    // record is one a human has already accepted and that demonstrably works.
    // An unbridged record is exactly what is under suspicion, so using one as
    // the reference would let a typo vouch for itself.
    // ⚠ ONE ENTRY PER RECORD PER LOCAL PART. A bridged record routinely
    // carries the same local part at two domains — BHC-02338 holds both
    // `chuck@thenewblank.com` and `chuck@crrnt.co` — and pushing the side once
    // per address put it in the `chuck` bucket twice, which emitted the same
    // typo candidate twice on the first live measurement. Caught by measuring
    // rather than by reading, which is why the count is reported before the
    // card is designed around it.
    const localsSeen = new Set<string>();
    for (const email of side.emails) {
      const domain = domainOf(email);
      if (domain !== '') bridgedDomains.add(domain);
      // ⚠ EXACT local part, NOT `normalizeLocalPart`. Stripping punctuation
      // would make `john.smith@a.com` match `johnsmith@b.com` — local-part
      // VARIANCE, which is the half of this signal that is not safe.
      //
      // ⚠ THIS MUST BE THE SAME FUNCTION `crmTypoHits` LOOKS UP WITH. If the
      // two disagree the failure is SILENT AND IN THE SAFE-LOOKING DIRECTION —
      // every punctuated local part simply stops matching and the arm quietly
      // finds less. Pinned by the hyphenated-local-part test.
      const local = localPartOf(email);
      if (local === '' || localsSeen.has(local)) continue;
      localsSeen.add(local);
      const bucket = byEmailLocalPart.get(local);
      if (bucket) bucket.push(side);
      else byEmailLocalPart.set(local, [side]);
    }

    if (side.nameKey === '') {
      unusableNameCount += 1;
      continue;
    }
    const bucket = byNameKey.get(side.nameKey);
    if (bucket) bucket.push(side);
    else byNameKey.set(side.nameKey, [side]);
  }

  // Co-located domains, derived from the data rather than hardcoded: a domain
  // that shares a bridged record with an owned-domain address is a domain
  // this workspace's own people are on. Freemail is excluded — half the
  // workspace has a gmail address on their record and it means nothing.
  const colocatedCounts = new Map<string, number>();
  for (const side of bridged) {
    const domains = side.emails.map(domainOf).filter((d) => d !== '');
    if (!domains.some(isOwnedDomain)) continue;
    for (const domain of new Set(domains)) {
      if (isOwnedDomain(domain) || isFreemail(domain)) continue;
      colocatedCounts.set(domain, (colocatedCounts.get(domain) ?? 0) + 1);
    }
  }
  const colocatedDomains = new Set(
    [...colocatedCounts.entries()].filter(([, n]) => n >= COLOCATED_MIN_RECORDS).map(([d]) => d),
  );

  const ambiguousKeys = [...byNameKey.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);

  return {
    byNameKey,
    byEmailLocalPart,
    bridgedDomains,
    bridgedCount: bridged.length,
    unusableNameCount,
    ambiguousKeys,
    colocatedDomains,
  };
}

// --- corroboration ------------------------------------------------------------

interface Comparison {
  readonly corroboration: string[];
  readonly distinguishing: string[];
  readonly strong: boolean;
  readonly weak: boolean;
}

function compare(subject: DuplicateSide, other: DuplicateSide, index: BridgedNameIndex): Comparison {
  const corroboration: string[] = [];
  const distinguishing: string[] = [];
  let strong = false;
  let weak = false;

  const label = other.bhcId ?? other.attioRecordId.slice(0, 8);

  // Shared company REFERENCE — never `company_name`, which our routines write
  // on bridged records only and Attio never populates (spec §3).
  if (subject.companyRecordId && other.companyRecordId) {
    if (subject.companyRecordId === other.companyRecordId) {
      corroboration.push(`same Attio company record as ${label}`);
      strong = true;
    } else {
      distinguishing.push(`different companies — subject and ${label} reference different Attio company records`);
    }
  } else if (subject.companyRecordId || other.companyRecordId) {
    distinguishing.push(`only one side has a company: ${subject.companyRecordId ? 'the unbridged record' : label} does`);
  }

  if (subject.linkedin && other.linkedin) {
    if (subject.linkedin.trim().toLowerCase() === other.linkedin.trim().toLowerCase()) {
      corroboration.push(`identical LinkedIn URL to ${label}`);
      strong = true;
    } else {
      distinguishing.push(`DIFFERENT LinkedIn URLs — ${subject.linkedin} vs ${other.linkedin}`);
    }
  } else if (subject.linkedin || other.linkedin) {
    distinguishing.push(`only one side has a LinkedIn URL: ${subject.linkedin ? 'the unbridged record' : label} does`);
  }

  // Email local-part. Corroboration ONLY: it also matches every info@ and
  // sales@ pair across unrelated domains, which is why it is never primary.
  const subjectLocals = new Set(subject.emails.map(normalizeLocalPart).filter((l) => l !== ''));
  const shared = [...new Set(other.emails.map(normalizeLocalPart))].filter((l) => l !== '' && subjectLocals.has(l));
  if (shared.length > 0) {
    corroboration.push(`shares an email local part with ${label} (${shared.join(', ')})`);
    weak = true;
  }

  // The Epic cohort. One side on an owned domain, the other on a domain this
  // workspace's own people demonstrably use — the exact shape Zoe Cattolico
  // (BHC-02386) already carries consolidated onto one record.
  const subjectDomains = subject.emails.map(domainOf).filter((d) => d !== '');
  const otherDomains = other.emails.map(domainOf).filter((d) => d !== '');
  const pairing =
    (otherDomains.some(isOwnedDomain) && subjectDomains.some((d) => index.colocatedDomains.has(d))) ||
    (subjectDomains.some(isOwnedDomain) && otherDomains.some((d) => index.colocatedDomains.has(d)));
  if (pairing) {
    corroboration.push(
      `owned-domain pairing with ${label} — one side is @${OWNED_DOMAINS.join('/@')}, the other is on a domain ` +
        'this workspace\'s own people are on. Merge here CONSOLIDATES BOTH ADDRESSES onto one record.',
    );
    weak = true;
  }

  if (subject.strength !== other.strength) {
    distinguishing.push(`connection strength differs: ${subject.strength ?? 'none'} vs ${other.strength ?? 'none'} (${label})`);
  }
  if (subject.firstInteractionAt && other.firstInteractionAt && subject.firstInteractionAt !== other.firstInteractionAt) {
    distinguishing.push(`first interaction differs: ${subject.firstInteractionAt} vs ${other.firstInteractionAt} (${label})`);
  }
  distinguishing.push(
    `addresses: unbridged [${subject.emails.join(', ') || 'none'}] vs ${label} [${other.emails.join(', ') || 'none'}]`,
  );

  return { corroboration, distinguishing, strong, weak };
}

const RANK: Record<DuplicateConfidence, number> = { low: 0, medium: 1, high: 2 };
const LEVELS: readonly DuplicateConfidence[] = ['low', 'medium', 'high'];

function downgrade(c: DuplicateConfidence): DuplicateConfidence {
  return LEVELS[Math.max(0, RANK[c] - 1)]!;
}

// --- detection ----------------------------------------------------------------

export interface DetectInput {
  /** The FULL unbridged population — never the post-suppression or post-exclusion subset. */
  readonly unbridged: readonly UnbridgedContact[];
  readonly index: BridgedNameIndex;
  readonly suppression: SuppressionIndex;
  /** Record id -> how STEP 1b suppressed it. Annotation only; it never filters detection. */
  readonly suppressedById?: ReadonlyMap<string, string>;
  /** Record id -> the STEP 2 hard-exclude reason. Annotation only; it never filters detection. */
  readonly hardExcludedById?: ReadonlyMap<string, string>;
}

export function detectDuplicates(input: DetectInput): DuplicateDetection {
  const { unbridged, index, suppression } = input;
  const suppressedById = input.suppressedById ?? new Map<string, string>();
  const hardExcludedById = input.hardExcludedById ?? new Map<string, string>();

  const sides = unbridged.map(unbridgedSide);
  const unbridgedByKey = new Map<string, DuplicateSide[]>();
  let unbridgedWithoutUsableName = 0;
  for (const side of sides) {
    if (side.nameKey === '') {
      unbridgedWithoutUsableName += 1;
      continue;
    }
    const bucket = unbridgedByKey.get(side.nameKey);
    if (bucket) bucket.push(side);
    else unbridgedByKey.set(side.nameKey, [side]);
  }

  const candidates: DuplicateCandidate[] = [];
  let exactNameAgainstBridged = 0;

  for (const subject of sides) {
    const typos = typoDomainHits(subject.emails);
    // CRM-as-reference: the second typo arm. Independent of the name match —
    // a typo record with no resolvable name must still surface.
    const crmTypos = crmTypoHits(subject.emails, index);
    // ⚠ A BLANK NAME NEVER MATCHES, and the guard lives in ONE place: every
    // index here refuses to store an empty key, so a blank-named subject
    // looks up a key that cannot exist. Mirroring the check here as well was
    // mutation-checked as redundant — neuter either copy and the other still
    // rejects the case, which means neither was actually being tested.
    const bridgedMatches = index.byNameKey.get(subject.nameKey) ?? [];
    const siblings = (unbridgedByKey.get(subject.nameKey) ?? []).filter(
      (s) => s.attioRecordId !== subject.attioRecordId,
    );
    const retired = suppression.byNameKey.get(subject.nameKey) ?? [];
    const orphanCleared = retired.filter((r) => r.kind === 'ORPHAN_CLEARED');

    if (bridgedMatches.length > 0) exactNameAgainstBridged += 1;

    // Nothing to say about this record.
    if (
      typos.length === 0 &&
      crmTypos.length === 0 &&
      bridgedMatches.length === 0 &&
      siblings.length === 0 &&
      orphanCleared.length === 0
    ) {
      continue;
    }

    const corroboration: string[] = [];
    const distinguishing: string[] = [];
    const cautions: string[] = [];
    let strong = false;
    let weak = false;

    for (const other of [...bridgedMatches, ...siblings]) {
      const c = compare(subject, other, index);
      corroboration.push(...c.corroboration);
      distinguishing.push(...c.distinguishing);
      strong = strong || c.strong;
      weak = weak || c.weak;
    }

    // --- kind, in precedence order.
    let kind: DuplicateKind;
    if (typos.length > 0 || crmTypos.length > 0) kind = 'exclude-typo-domain';
    else if (orphanCleared.length > 0) kind = 'repoint';
    else if (bridgedMatches.length > 0) kind = 'merge-into-bridged';
    else if (siblings.length > 0) kind = 'consolidate-unbridged';
    else continue;

    const repointTo = orphanCleared.map((r) => canonicalBhcIdIn(r.quote)).find((id) => id !== null) ?? null;

    // --- confidence.
    let confidence: DuplicateConfidence;
    const singleToken = isSingleTokenKey(subject.nameKey);

    if (kind === 'exclude-typo-domain') {
      // High confidence about what this ISN'T. A domain one character from an
      // owned domain is misaddressed mail, not a person.
      confidence = 'high';
    } else if (kind === 'repoint') {
      confidence = repointTo !== null ? 'high' : 'low';
    } else if (singleToken) {
      // ⚠ LOCKED LOW, never raised by corroboration. "Le" matching BHC-01225 is
      // a live one-token collision between an Amazon address and a New York
      // Times one, and no amount of secondary signal makes a single shared word
      // into an identity.
      confidence = 'low';
    } else if (strong) {
      confidence = 'high';
    } else if (weak) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    // --- cautions.
    for (const t of crmTypos) {
      cautions.push(
        `TYPO OF A KNOWN-GOOD ADDRESS: ${t.email} is ${t.distance} character(s) from ${t.referenceEmail}, ` +
          `which is already on ${t.reference.bhcId ?? t.reference.attioRecordId} ` +
          `(${t.reference.name ?? 'no name'}) — an address a human has accepted and that works. ` +
          'Same local part, near-miss domain. Not a duplicate person, and not a person.',
      );
    }
    if (singleToken && kind !== 'exclude-typo-domain') {
      cautions.push(
        `ONE-TOKEN NAME ("${subject.name ?? ''}") — the match rests on a single word and is very likely a collision. ` +
          'Confidence is locked low regardless of other signals.',
      );
    }
    if (typos.length > 0) {
      for (const t of typos) {
        cautions.push(
          `TYPO DOMAIN: ${t.email} is ${t.distance} character from the owned domain ${t.nearest}. ` +
            'This is misaddressed mail Attio materialised into a person record — not a duplicate person, and not a person. ' +
            'Default action is EXCLUDE, not merge.',
        );
      }
    }
    if (bridgedMatches.length > 1) {
      cautions.push(
        `${bridgedMatches.length} BRIDGED records share this name (${bridgedMatches.map((b) => b.bhcId).join(', ')}). ` +
          'Two people can share a name. ⚠ If any two BRIDGED records are merged, the primary\'s bhc_contact_id wins ' +
          'and the secondary\'s is SILENTLY DISCARDED — the field is non-unique, so nothing errors.',
      );
      confidence = downgrade(confidence);
    }
    if (kind === 'consolidate-unbridged') {
      cautions.push(
        'NEITHER record carries a BHC_ID. If these are one person, they must end as ONE record with ONE BHC_ID — ' +
          'minting each separately creates the duplicate this would have prevented.',
      );
    }
    if (retired.length > 0) {
      for (const r of retired) {
        cautions.push(
          `name matches a retired identity at Master_ID row ${r.masterRow} (${r.kind}): "${r.quote}"`,
        );
      }
    }
    cautions.push(
      'A merge produces a NEW record_id matching neither input and both originals become unreadable. Every ' +
        'Master_ID.Attio_Record_ID pointing at either goes stale the instant it commits, and nothing announces it.',
    );

    // --- the ask.
    const proposedAction =
      kind === 'exclude-typo-domain'
        ? 'EXCLUDE — misaddressed mail at a typo domain, not a person.'
        : kind === 'repoint'
          ? `REPOINT to ${repointTo ?? '(the annotation names no BHC_ID — resolve by hand)'} — this identity is already tracked under that BHC_ID.`
          : kind === 'merge-into-bridged'
            ? `MERGE into ${bridgedMatches.map((b) => b.bhcId).join(' or ')} — CONSOLIDATES BOTH ADDRESSES onto the bridged record; ` +
              'the BHC_ID survives because the unbridged side has none to compete. Or MINT AS NEW if they are two people.'
            : 'MERGE the unbridged records in Attio first, then mint ONE BHC_ID. Or MINT AS NEW if they are two people.';

    candidates.push({
      kind,
      confidence,
      nameKey: subject.nameKey,
      subject,
      bridgedMatches,
      unbridgedSiblings: siblings,
      ownedDomainTypos: typos,
      crmTypos,
      repointTo,
      retiredMatches: retired,
      corroboration,
      distinguishing,
      cautions,
      proposedAction,
      gating: {
        suppressedBy: suppressedById.get(subject.attioRecordId) ?? null,
        hardExcludedBy: hardExcludedById.get(subject.attioRecordId) ?? null,
      },
    });
  }

  const byKind: Record<DuplicateKind, number> = {
    'merge-into-bridged': 0,
    'consolidate-unbridged': 0,
    repoint: 0,
    'exclude-typo-domain': 0,
  };
  const byConfidence: Record<DuplicateConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const c of candidates) {
    byKind[c.kind] += 1;
    byConfidence[c.confidence] += 1;
  }

  const ownedTypoCandidates = candidates.filter((c) => c.ownedDomainTypos.length > 0).length;
  const crmTypoCandidates = candidates.filter((c) => c.crmTypos.length > 0).length;
  const crmTypoBeyondOwned = candidates.filter(
    (c) => c.crmTypos.length > 0 && c.ownedDomainTypos.length === 0,
  ).length;

  return {
    ownedTypoCandidates,
    crmTypoCandidates,
    crmTypoBeyondOwned,
    candidates: [...candidates].sort(
      (a, b) => RANK[b.confidence] - RANK[a.confidence] || a.nameKey.localeCompare(b.nameKey),
    ),
    exactNameAgainstBridged,
    unbridgedClusters: [...unbridgedByKey.values()].filter((v) => v.length > 1).length,
    byKind,
    byConfidence,
    colocatedDomains: [...index.colocatedDomains].sort(),
    ambiguousBridgedKeys: index.ambiguousKeys,
    bridgedWithoutUsableName: index.unusableNameCount,
    unbridgedWithoutUsableName,
    singleTokenNameCandidates: candidates.filter((c) => isSingleTokenKey(c.nameKey)).length,
  };
}
