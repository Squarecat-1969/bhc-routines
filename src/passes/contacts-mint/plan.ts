/**
 * STEP 4c — the ordered write plan. CLAUSES 2, 3, 4 AND 5.
 *
 * ⚠ THIS MODULE PRODUCES A PLAN AND CANNOT EXECUTE ONE. There is no client
 * here, no SheetsClient, no AttioClient, no import that can reach a network.
 * A dry run is not "the live path with a flag off" — it is the only path that
 * exists, and the executor is a separate build that runs after Bobby confirms
 * the first mint. Nothing in this file can write to the identity bridge.
 *
 * ─── THE ORDER, AND WHY IT IS THAT WAY ──────────────────────────────────────
 *
 *   2. Master_ID stub row FIRST.
 *   3. Then re-stamp the Attio record.
 *   4. Then reconcile the stub with the record id.
 *   5. Fail loud at any step. Never leave a silent orphan.
 *
 * THE FAILURE MODES ARE NOT SYMMETRIC, and that asymmetry is the whole reason:
 *
 *   Master_ID first → a failure at the Attio step leaves a stub with no
 *   pointer. Visible, repairable, and the Reconciler catches it as an S2.
 *
 *   Attio first → a failure at the Master_ID step leaves a STAMPED RECORD WITH
 *   NO BRIDGE ROW. Invisible to every sweep, because the Reconciler's candidate
 *   set is the pipeline list and an unbridged-but-stamped record is on neither.
 *
 * One is noisy and fixable. The other is silent and cumulative.
 *
 * ⚠ LIVE CODE CURRENTLY DOES THIS BACKWARDS. `bhc-aida`'s handleReStamp writes
 * Attio first and appends Master_ID afterwards — and on an append failure it
 * pushes a WARNING and returns `ok: true, result: "minted"`. That is both
 * clause 2 and clause 5 violated in one path: the silent orphan, reported as a
 * success. Written down here because a future reader comparing the two will
 * otherwise assume the shipped one is the reference.
 *
 * ─── STEP 3 IS A RE-STAMP, NOT A CREATE ─────────────────────────────────────
 *
 * The Attio records already exist — Attio's own email sync made them. Nothing
 * is brought into being; an existing record gains an ID. This is materially
 * SAFER than the creation path the contract was written for, and it has one
 * structural consequence: the record id is known before step 1, so the stub is
 * written complete and clause 4 degenerates from "fill in the missing pointer"
 * to "verify the pointer you already wrote". The verification step is kept
 * rather than dropped, because "a tool or API returning success is not
 * evidence" applies to the Sheets append exactly as much as to the Attio PATCH.
 */

import type { MintCandidate } from './candidates.js';

export type MintSystem = 'master-id' | 'attio';
export type MintStepKind = 'append' | 'update' | 'read-back';

export interface MintStep {
  /** 1-based execution order. NEVER reorder — see the header. */
  readonly order: number;
  readonly system: MintSystem;
  readonly kind: MintStepKind;
  /** One line, in the imperative, for the dry-run output. */
  readonly description: string;
  /** A1 range for a Sheets step. */
  readonly range?: string;
  /** Exactly the row that would be appended — column order is load-bearing. */
  readonly values?: readonly (string | number)[];
  /** Attio record id for an Attio step. */
  readonly recordId?: string;
  readonly field?: string;
  readonly value?: string;
  /** What must be true after this step, or the whole mint aborts. */
  readonly assertion: string;
}

export interface MintPlan {
  readonly bhcId: string;
  readonly attioRecordId: string;
  readonly fullName: string;
  readonly email: string;
  readonly steps: readonly MintStep[];
}

/**
 * Master_ID column order, verified live 2026-09-05 against the tab's own header
 * row: A BHC_ID · B Full_Name · C Location · D Google_Row · E Attio_Record_ID ·
 * F Notes.
 *
 * ⚠ Location is ATTIO and Google_Row is BLANK, deliberately. These are
 * Attio-native contacts: per the two-CRM split, Google is the LinkedIn reach
 * engine and a record that arrived by email or calendar belongs in Attio alone.
 * No Contacts sheet row is created, so there is no Google_Row to point at — and
 * inventing one would break the rule that Google_Row is the only authority for
 * which Contacts row to touch.
 */
export const MASTER_ID_APPEND_RANGE = 'Master_ID!A2:F';
export const MASTER_ID_COLUMNS = ['BHC_ID', 'Full_Name', 'Location', 'Google_Row', 'Attio_Record_ID', 'Notes'] as const;

export function planMint(candidate: MintCandidate, bhcId: string): MintPlan {
  const c = candidate.contact;
  const recordId = c.attioRecordId;
  const fullName = (c.name ?? '').trim();
  const email = (c.primaryEmail ?? c.allEmails[0] ?? '').trim();

  const steps: MintStep[] = [
    {
      order: 1,
      system: 'master-id',
      kind: 'append',
      description: `Append the Master_ID stub for ${bhcId} — BEFORE Attio is touched.`,
      range: MASTER_ID_APPEND_RANGE,
      values: [bhcId, fullName, 'ATTIO', '', recordId, candidate.sourceContext],
      assertion:
        'The append returns and a read-back finds exactly one row with this BHC_ID. '
        + 'If it fails: ABORT, write nothing to Attio. No ID is spent, nothing is orphaned.',
    },
    {
      order: 2,
      system: 'master-id',
      kind: 'read-back',
      description: `Read Master_ID back and confirm ${bhcId} landed exactly once.`,
      range: MASTER_ID_APPEND_RANGE,
      assertion:
        'Exactly one row carries this BHC_ID and its Attio_Record_ID equals the target record. '
        + 'Zero rows or two rows: ABORT before Attio. A success response is not evidence.',
    },
    {
      order: 3,
      system: 'attio',
      kind: 'update',
      description: `RE-STAMP the existing Attio record with ${bhcId} (the record already exists — nothing is created).`,
      recordId,
      field: 'bhc_contact_id',
      value: bhcId,
      assertion:
        'PATCH returns 200. If it fails: FAIL LOUD, leaving the stub in place — a stub with no '
        + 'pointer is visible to the Reconciler as an S2 and is repairable.',
    },
    {
      order: 4,
      system: 'attio',
      kind: 'read-back',
      description: `Read the Attio record back and confirm bhc_contact_id == ${bhcId}.`,
      recordId,
      field: 'bhc_contact_id',
      value: bhcId,
      assertion:
        'The re-read returns the stamp. A PATCH reporting success over a write that did not '
        + 'happen has been demonstrated in this system more than once.',
    },
    {
      order: 5,
      system: 'master-id',
      kind: 'read-back',
      description:
        'Clause 4 — reconcile the stub against the record id. A re-stamp knows the record id '
        + 'up front, so this VERIFIES the pointer written at step 1 rather than filling it in.',
      range: MASTER_ID_APPEND_RANGE,
      assertion:
        `Master_ID row for ${bhcId} carries Attio_Record_ID ${recordId}, Location ATTIO, blank Google_Row. `
        + 'Any mismatch: FAIL LOUD and report both systems’ values. Never silently repair.',
    },
  ];

  return { bhcId, attioRecordId: recordId, fullName, email, steps };
}

/**
 * Plan a whole batch, SERIALLY.
 *
 * ⚠ THE IDS HERE ARE A PROJECTION. Each live mint must re-read the maximum
 * across both systems immediately before its own step 1 — Attio's sync can
 * stamp a record between two mints in a batch. Executing this array without
 * re-reading is a parallel mint with serial-looking code, which is the confirmed
 * root cause of this system's duplicate-identity history in two independent
 * code paths.
 *
 * ⚠ AND THE FIRST LIVE WRITE IS NOT A BATCH AT ALL. Mint exactly one, confirmed
 * by Bobby, and read both systems back before any second mint is considered.
 */
export function planBatch(
  candidates: readonly MintCandidate[],
  ids: readonly string[],
): readonly MintPlan[] {
  if (candidates.length !== ids.length) {
    throw new Error(
      `planBatch: ${candidates.length} candidates but ${ids.length} ids — refusing to guess the pairing.`,
    );
  }
  return candidates.map((c, i) => planMint(c, ids[i]!));
}
