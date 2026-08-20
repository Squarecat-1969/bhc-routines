/**
 * PASS 4 - Attio pointer + name checks (A1-A5), the I1 identity-drift gate, and
 * Name_Conflicts candidate generation. Pure: the caller does the fetching.
 */

import { fieldEqual, namesExact, sharesWord } from '../../lib/name-match.js';
import type { Finding, GoogleIdentity, MasterRow, NameConflictCandidate } from './types.js';

/** What one Attio lookup produced. */
export type AttioLookup =
  | { readonly kind: 'ok'; readonly bhcContactId: string; readonly name: string; readonly jobTitle: string; readonly companyName: string; readonly emails: readonly string[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failed'; readonly error: string };

/** The A5 split's outcomes. */
export type NameOutcome = 'unavailable' | 'exact' | 'shares_word' | 'zero_words';

export function classifyName(attioName: string, masterName: string): NameOutcome {
  if (attioName.trim() === '' || masterName.trim() === '') return 'unavailable';
  if (namesExact(attioName, masterName)) return 'exact';
  if (sharesWord(attioName, masterName)) return 'shares_word';
  return 'zero_words';
}

export interface AttioPassResult {
  readonly findings: readonly Finding[];
  readonly nameConflictCandidates: readonly NameConflictCandidate[];
}

export function attioChecks(
  rows: readonly MasterRow[],
  lookups: ReadonlyMap<string, AttioLookup>,
  googleIdentity: ReadonlyMap<number, GoogleIdentity>,
): AttioPassResult {
  const findings: Finding[] = [];
  const candidates: NameConflictCandidate[] = [];

  for (const row of rows) {
    if (row.attioRecordId === '') continue; // S3's job

    const look = lookups.get(row.attioRecordId);
    if (!look || look.kind === 'failed') {
      findings.push({ code: 'A4', row, expected: 'a successful lookup', found: look?.kind === 'failed' ? look.error : 'no result', notes: 'lookup failed after retries' });
      continue;
    }
    if (look.kind === 'not_found') {
      findings.push({ code: 'A3', row, expected: `record ${row.attioRecordId}`, found: '(not found)', notes: 'stale pointer - record deleted or merged in Attio' });
      continue;
    }

    // ID check
    let a1Passed: boolean;
    if (look.bhcContactId === '') {
      findings.push({ code: 'A2', row, expected: row.bhcId, found: '(blank)', notes: 'Attio record has no bhc_contact_id' });
      a1Passed = false;
    } else if (look.bhcContactId !== row.bhcId) {
      findings.push({ code: 'A1', row, expected: row.bhcId, found: look.bhcContactId, notes: 'identity bridge has drifted' });
      a1Passed = false;
    } else {
      a1Passed = true;
    }

    // Name check (A5 split)
    const outcome = classifyName(look.name, row.fullName);
    if (outcome === 'zero_words') {
      // A row can produce BOTH A1 and A5 - the spec is explicit about that.
      findings.push({
        code: 'A5', row, expected: row.fullName, found: look.name,
        notes: `zero significant words in common (bhc_contact_id=${look.bhcContactId})`,
      });
    }

    // I1 - BOTH only, A1 passed, name matched (never the zero-word case)
    const nameOk = outcome === 'exact' || outcome === 'shares_word';
    if (row.location === 'BOTH' && a1Passed && nameOk && row.googleRow !== null) {
      const g = googleIdentity.get(row.googleRow);
      if (g) {
        findings.push(...identityDrift(row, g, look));
        // Name drift never becomes an I1 row - it queues for human review.
        if (outcome === 'shares_word') {
          const googleName = `${g.firstName} ${g.lastName}`.trim();
          // A pair that is not a difference is not a conflict.
          //
          // The A5 gate above fires on Attio-vs-MASTER_ID, but the row enqueued
          // here is Attio-vs-GOOGLE. Those are different comparisons, so when
          // Master_ID's own name is stale ("Susan Corcoran") while Google and
          // Attio already agree ("Sue Corcoran"), the gate opens and the pair
          // is identical — producing a review card that asks a human to choose
          // between a name and itself. Three of those reached the live queue on
          // RECON-1787181038868 (BHC-00175 / 00208 / 00234).
          //
          // Guarded with fieldEqual, the same comparator I1 uses, so a pure
          // formatting difference (case, punctuation, spacing) is treated as
          // agreement too. NOTE the consequence: a genuine case-only drift
          // ("bo geddes" vs "Bo Geddes") no longer queues. That is deliberate
          // per the agreed fix, and worth knowing — it is a narrowing of what
          // reaches human review, not just a no-op filter.
          if (!fieldEqual(look.name, googleName)) {
            candidates.push({
              bhcId: row.bhcId,
              oldName: look.name,
              newName: googleName,
              googleRow: row.googleRow,
              attioRecordId: row.attioRecordId,
              masterRow: row.masterRow,
            });
          }
        }
      }
    }
  }

  return { findings, nameConflictCandidates: candidates };
}

/**
 * Title / Company / Email only. Never segment, never stage, NEVER Name.
 * A blank Google value is skipped - nothing authoritative to sync from.
 */
function identityDrift(
  row: MasterRow,
  g: GoogleIdentity,
  look: Extract<AttioLookup, { kind: 'ok' }>,
): readonly Finding[] {
  const out: Finding[] = [];

  if (g.title !== '' && !fieldEqual(g.title, look.jobTitle)) {
    out.push({ code: 'I1', row, expected: g.title, found: look.jobTitle || '(blank)', notes: 'Title' });
  }
  if (g.company !== '' && !fieldEqual(g.company, look.companyName)) {
    out.push({ code: 'I1', row, expected: g.company, found: look.companyName || '(blank)', notes: 'Company' });
  }
  if (g.primaryEmail !== '') {
    // A match means Google's primary appears ANYWHERE in Attio's multi-value
    // set - Attio legitimately holds several addresses.
    const present = look.emails.some((e) => fieldEqual(e, g.primaryEmail));
    if (!present) {
      out.push({ code: 'I1', row, expected: g.primaryEmail, found: look.emails.join(', ') || '(blank)', notes: 'Email' });
    }
  }

  return out;
}
