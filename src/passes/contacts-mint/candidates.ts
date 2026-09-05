/**
 * STEP 4b — who may be minted, and who may not.
 *
 * Three exclusions, each protecting against a different failure, each re-run at
 * MINT TIME rather than trusted from a queue row written hours earlier.
 *
 * ⚠ WHY RE-CHECK RATHER THAN TRUST THE QUEUE. A human may have retired an
 * identity between the queue write and the confirmation. The queue row is a
 * snapshot of what was true when the nightly pass ran; the mint is a write to
 * the identity bridge happening now. The contract's own words: "A gate that
 * exists on two of three stages is not a gate — it is a gap waiting to be
 * found."
 *
 * ⚠ SUPPRESSION IS NOT A VOLUME OPTIMISATION. Raymond Yang was scrapped
 * 2026-08-05 and Attio's email sync re-created him on 2026-08-30 and again on
 * 2026-09-01. Automatic minting would have issued him a BHC_ID twice in three
 * days. Suppression is what remembers a human already answered.
 *
 * ⚠ DUPLICATE CANDIDATES ARE EXCLUDED, NOT DEFERRED-BY-CONVENTION. Minting a
 * record that is about to be merged spends an ID and a Master_ID row on a
 * record that will stop existing — and the fresh bhc_contact_id may not even
 * survive: the field is `is_unique: false` and single-value, so on merge the
 * primary's value wins and the secondary's vanishes without an error. Detect,
 * then mint. Never the reverse.
 */

import type { ExclusionIndex } from '../contacts-triage/exclusions.js';
import { classifySuppression, type SuppressionIndex } from '../contacts-triage/suppression.js';
import type { UnbridgedContact } from '../contacts-triage/types.js';

export type MintBlockReason =
  /** A human already retired this identity — Master_ID SUPERSEDED or Contact_Exclusions. */
  | 'suppressed'
  /** Flagged by steps 2/3 as a duplicate or typo-domain candidate. */
  | 'duplicate-candidate'
  /** No email address. Flagged for manual resolution; never spawned from a name. */
  | 'no-email'
  /** No name on the record — nothing to verify a stamp against. */
  | 'no-name'
  /** Already carries a bhc_contact_id. Nothing to mint. */
  | 'already-bridged';

export interface MintBlocked {
  readonly contact: UnbridgedContact;
  readonly reason: MintBlockReason;
  /** Quoted justification, so a blocked record is auditable rather than absent. */
  readonly detail: string;
}

export interface MintCandidate {
  readonly contact: UnbridgedContact;
  /** Provenance written into Master_ID column F. */
  readonly sourceContext: string;
}

export interface MintSelection {
  readonly candidates: readonly MintCandidate[];
  readonly blocked: readonly MintBlocked[];
}

export interface SelectMintCandidatesInput {
  readonly contacts: readonly UnbridgedContact[];
  /** Re-read at mint time. Never the copy the nightly pass used. */
  readonly suppression: SuppressionIndex;
  readonly exclusions: ExclusionIndex;
  /**
   * Attio record ids carrying an unresolved duplicate/typo flag, from
   * Contacts_Triage_Queue's duplicate columns. Re-read at mint time: a pair
   * resolved as "different people" since the queue write is mintable again,
   * and one raised since is not.
   */
  readonly duplicateFlagged: ReadonlySet<string>;
  /** bhc_contact_id by record id, live from Attio — the already-bridged check. */
  readonly bridged: ReadonlyMap<string, string>;
  readonly runDate: string;
}

/**
 * Partition the population into mintable and blocked.
 *
 * ⚠ ORDER MATTERS FOR THE AUDIT LINE, NOT FOR CORRECTNESS. A record can trip
 * several exclusions at once — the live Raymond Yang pair is both suppressed
 * AND a duplicate candidate. The first reason is reported, and suppression
 * leads because it is the one carrying a human's written decision, which is
 * more informative than "this looks like a duplicate".
 *
 * ⚠ NOTHING IS SILENTLY DROPPED. Every input contact appears in exactly one of
 * the two output lists. A suppression nobody can audit is indistinguishable
 * from a bug that loses records.
 */
export function selectMintCandidates(input: SelectMintCandidatesInput): MintSelection {
  const candidates: MintCandidate[] = [];
  const blocked: MintBlocked[] = [];

  for (const contact of input.contacts) {
    const id = contact.attioRecordId;

    // ── Already bridged ───────────────────────────────────────────────────
    const stamp = input.bridged.get(id);
    if (stamp !== undefined && stamp.trim() !== '') {
      blocked.push({
        contact,
        reason: 'already-bridged',
        detail: `Attio record already carries bhc_contact_id ${stamp.trim()} — nothing to mint.`,
      });
      continue;
    }

    // ── Suppression, re-checked live ──────────────────────────────────────
    const suppression = classifySuppression(contact, input.suppression, input.exclusions);
    if (suppression !== null) {
      blocked.push({
        contact,
        reason: 'suppressed',
        detail: suppression.reason,
      });
      continue;
    }

    // ── Duplicate / typo candidate ────────────────────────────────────────
    if (input.duplicateFlagged.has(id)) {
      blocked.push({
        contact,
        reason: 'duplicate-candidate',
        detail:
          'flagged as a duplicate or typo-domain candidate — minting would spend an ID on a '
          + 'record that is about to be merged, and bhc_contact_id may not survive the merge.',
      });
      continue;
    }

    // ── No email: flagged for manual resolution, never auto-created ───────
    const email = (contact.primaryEmail ?? '').trim();
    if (email === '' && contact.allEmails.length === 0) {
      blocked.push({
        contact,
        reason: 'no-email',
        detail: 'no email address on the record — flagged for manual resolution, never spawned from a name fragment.',
      });
      continue;
    }

    // ── No name: nothing to verify a stamp against ────────────────────────
    if ((contact.name ?? '').trim() === '') {
      blocked.push({
        contact,
        reason: 'no-name',
        detail: 'no name on the Attio record — a stamp cannot be verified against an unidentifiable record.',
      });
      continue;
    }

    candidates.push({
      contact,
      sourceContext: `contacts-mint ${input.runDate} · Attio-native (${email || contact.allEmails[0]})`,
    });
  }

  return { candidates, blocked };
}

/** Counts for the report, so a shrinking population is explained not just observed. */
export function blockedByReason(blocked: readonly MintBlocked[]): Record<MintBlockReason, number> {
  const out: Record<MintBlockReason, number> = {
    suppressed: 0,
    'duplicate-candidate': 0,
    'no-email': 0,
    'no-name': 0,
    'already-bridged': 0,
  };
  for (const b of blocked) out[b.reason] += 1;
  return out;
}
