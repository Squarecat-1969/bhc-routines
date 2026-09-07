# Spec — the identity re-resolution pass

**Repo:** `bhc-routines` · **Drafted:** 2026-09-07 · **Status:** SPEC ONLY, not built
**Measured live 2026-09-07** against 395 `Brain_Complete` rows, 2,515 `Master_ID` rows and production Attio. Every figure below is a measurement with its date, not an estimate.

---

## 0. The defect, confirmed in code

`resolveContact` has exactly one caller — [pass2/index.ts:269](../src/passes/pass2/index.ts#L269), on the thread being processed that night. After PASS 2 appends the row:

| pass | touches `Brain_Complete` | column B |
|---|---|---|
| PASS 2 | appends `A:AD` once | **written here, once, forever** |
| PASS 3 | reads W, AA | — |
| PASS 5 | reads B, C, F, K, U, W, X, AC, AD | **reads, never writes** |
| Part D | writes U and V, narrow ranges | — |
| PASS 1 | blanks trailing rows during compaction | — |

**Nothing writes column B after the append.** A row written unresolved stays unresolved.

> **One correction to the brief.** PASS 5 *does* read column B ([pass5/brain-complete-read.ts](../src/passes/pass5/brain-complete-read.ts)), not just W and AA — but only for rows where `AB == runId`, and it never writes. The conclusion is unchanged; the detail matters because it tells us who consumes B.

---

## 1. ⚠ THE SECOND HALF OF THE DEFECT, AND IT CHANGES THE SHAPE OF THE FIX

**Part D is scoped to one run.** [load-run-set.ts:154](../src/part-d/load-run-set.ts#L154) skips every row where `AB != runId`, then skips every row where `V` is non-blank.

Measured: **all 347 blank-B rows have `V` blank.** Not one has ever been closed by Part D.

So the two gates compound. A July row is unreachable by tonight's Part D because its `AB` is a July Run_ID — regardless of what column B says.

⚠ **WRITING COLUMN B ALONE CHANGES NOTHING DOWNSTREAM TODAY.** It fixes the historical record and it makes the row *capable* of being processed, but no existing consumer will process it. Anyone specifying this pass as "re-resolve and the interaction lands on the contact record" is specifying two passes and describing one.

**This spec covers the identity half only.** Re-opening a historical row for execution is a separate decision with a much larger blast radius — it would replay months of interactions onto live CRM records — and it should not be smuggled in as an implementation detail of a backfill.

---

## 2. The population, measured 2026-09-07

395 rows · **48 populated · 347 blank**.

**The blank rate is rising, not a fixed backlog:**

| last-email month | blank / total | |
|---|---|---|
| 2026-06 | 26 / 36 | 72% |
| 2026-07 | 75 / 88 | 85% |
| 2026-08 | 195 / 216 | 90% |
| 2026-09 | 48 / 52 | **92%** |

**Re-running the existing cascade against all 347, today**, with no changes to it:

| outcome | rows | what it means |
|---|---|---|
| **RESOLVABLE** | **35** | resolves now — **all 35 via step 2 (Attio), ZERO via step 1 (Contacts)** |
| NEW_CANDIDATE | 206 | no Attio record at all. Unreachable by any resolver |
| UNRESOLVED | 23 | Attio record exists but is ambiguous or unbridged |
| NO_PRIMARY_EMAIL | 83 | no external party derivable — structurally unresolvable |

Of the 35: **32 are actionable** (`W != NO_ACTION`), across **21 distinct BHC_IDs**. Joleen Hughes (rows 280, 287 → BHC-02450) and Karen Hutton (row 353 → BHC-02535) are both in it, as predicted.

---

## 3. Which rows it reconsiders, and how it stops re-judging forever

⚠ **A pass that retries all 347 nightly is spend with no progress, reported green.** 289 of them (83 + 206) cannot resolve tonight by any mechanism this pass controls.

**The four classes have different destinies, and a single watermark cannot express that.** A high-water row number says "I have been this far"; it cannot say "this row will never resolve" or "this row will resolve the day someone mints its contact".

**Recommended: a per-row class marker plus a corpus fingerprint.**

- **`NO_PRIMARY_EMAIL` → TERMINAL.** 83 rows, marked once, never re-read. There is no email to resolve; no future state changes that. This is the only class that can be closed permanently, and it is 24% of the population.
- **Every other class → retry only when the inputs could have changed.** Store, per row, the fingerprint of the resolver's corpus at the last attempt — the Contacts email-map size and the count of bridged Attio records. Re-attempt only when the fingerprint has moved.

  A **timestamp says when you last tried; a fingerprint says whether anything could have changed since.** The 206 NEW_CANDIDATE rows resolve only after an upstream mint, and a mint moves the bridged count. That is the signal, and it is free to compute — this pass already loads both corpora.

- An **attempt count is the wrong primitive on its own.** "Tried 3 times, give up" would permanently abandon rows whose contact is minted in week four, which is precisely the Joleen Hughes case this pass exists to catch.

**Where the state lives — and this is a real decision, not a detail.** `Brain_Complete` is `A:AD` and five passes read it positionally; PASS 1 blanks `A:AD` during compaction and PASS 2 appends a fixed-width row. **Adding a column touches all of that.** Recommend a **separate `Reresolution_State` tab** keyed by `thread_id` (column A, stable and unique), following the `Contacts_Triage_Queue` precedent. No schema change to a tab five passes depend on.

---

## 4. How it resolves — and it should NOT widen

**Use the existing cascade unchanged.** The evidence is unusually clean: **all 35 recoveries came from step 2 (Attio); step 1 (Contacts, 33% coverage) contributed zero.** Every row this pass can recover is recoverable because *Attio bridging caught up*, which is exactly what the existing step 2 already tests.

⚠ **Widening the resolver would buy nothing and cost the thing §5 protects.** The 206 NEW_CANDIDATE rows have no Attio record — no lookup strategy reaches a record that does not exist. The only fixes for them are upstream: minting, which is `contacts-mint`'s job, and bridging, which is `contacts-triage`'s. **This pass should not grow a fuzzy matcher to chase them.** Name or domain matching against a 2,515-row registry is precisely how a wrong ID gets written, and §5 explains what a wrong ID costs.

**The root cause is upstream and this pass does not address it.** 2,084 of 2,515 Master_ID identities are Attio-only; an unbridged Attio record converts directly into an empty identity because [resolve.ts:60](../src/passes/pass2/resolve.ts#L60) requires a `bhc_contact_id` before it will return a match. This pass harvests what bridging has already fixed. **It is a lagging indicator of upstream health, not a fix for it** — and if it is ever reported as "N rows recovered", that number is a measure of how well `contacts-triage` is doing, not this pass.

**Cost:** one `searchPeopleByEmail` per row with an email — **264 calls** for an unbounded full sweep. That is the whole reason §3's retry gate is not optional.

---

## 5. What it writes, and where the human line is

**Writes column B only, one narrow range per row** (`Brain_Complete!B{row}`), re-read to confirm. Precedent: the 2026-09-06 backfill. ⚠ A wide write from a partial read fabricates every column it did not read — PASS 2's REVIEW writes, 2026-08-27.

### ⚠ `verifyName` against column C is the WRONG gate here

This is the sharpest finding in the investigation and it inverts the obvious design.

Running `verifyName(column C, Master_ID name)` over the 35 gives **30 MATCH, 5 MISMATCH**. **All five mismatches are false alarms:**

| row | column C | resolved to | why C is wrong |
|---|---|---|---|
| 224, 326, 383, 384 | `lejaking@gmail.com,…` / `gsaproposal@gmail.com,…` | Lance King / Patrick Suarez | C holds the **raw address**, not the name — the person *is* on the thread |
| 63 | `Lana Hougham` | Mary Johnson | C names a **different person entirely**; the thread is `FW: HMLG Billing`, primary `mjohnson@hmlglaw.com`, secondary `jhughes@hmlglaw.com` |

**Column C is a Thread_Staging display-name field that lists arbitrary participants and often a raw address.** Gating on it would withhold 5 correct resolutions out of 35 — a 14% false-positive rate on the only rows that matter — and the first thing a reader would learn is to override the gate.

### The right gate is the one PASS 2 already has

**Reuse `checkDrift`.** It verifies the ID against the *systems of record* — Attio's `bhc_contact_id`, `Master_ID.Attio_Record_ID`, and Contacts col A at the Google_Row — rather than against an unreliable label. The identity key here is the **email**, and the email is what the cascade matched on.

**AUTO-WRITE** when all of:
- the cascade returns `source = CONTACTS | ATTIO` with a non-null `bhcId`, **and**
- `checkDrift` is clean, **and**
- the resolved BHC_ID exists in `Master_ID` and is **not** SUPERSEDED, **and**
- the resolved email is the row's own derived primary email.

That is a mechanical copy of a fact each system already agrees on.

**WITHHOLD for a human** when any of:
- drift is dirty, or the ID is SUPERSEDED or absent from `Master_ID`;
- the row is multi-party **and** the derived primary email is not among column C's addresses — the row 63 / row 151 shape, where the question is *who the primary contact is*, not *what this address resolves to*. That is a judgement, and §0 of the QC manifest applies: a checker cannot tell a mistake from an intention.

⚠ **The asymmetry that sets the line:** an empty column B is *visibly* unresolved. A wrong-but-live ID looks fully resolved and directs a real conversation onto the wrong person's record. Withholding costs one review card; a wrong write costs a corrupted contact and is invisible.

---

## 6. Where it belongs — its own pass, and NOT in the nightly chain

**Not PASS 2.5** (reconciles open tasks against `Activity_Log`). **Not PASS 2.6** (reconciles open tasks against calendar evidence). Both reconcile **tasks**; this reconciles **identity on already-written rows**. Different subject, different source, different write target.

**And not nightly.** PASS 2.6's own header states the principle exactly: *"the two run on different clocks… Folding them together forces one cadence onto two sources that do not move at the same rate."* This pass's input moves on the **bridging clock** — when `contacts-triage` bridges a record or `contacts-mint` mints one — not the email clock. Running it nightly spends 264 Attio calls to discover that nothing has been bridged since yesterday.

**Recommendation: its own pass, triggered after `contacts-mint` / `contacts-triage`, plus a weekly safety net.** That is the same shape §089.4 locked for index maintenance, and for the same reason: the work exists only when an upstream human act has created it.

---

## 7. Risks, stated plainly

1. **⚠ It does not do what it appears to do.** Column B alone changes no downstream behaviour (§1). If the goal is the interaction reaching the CRM, that is a second pass and a much larger decision.
2. **The recoverable slice is small and its size is not this pass's to control.** 35 of 347 today; the other 289 are upstream. A report saying "35 recovered" must not read as "312 remain broken" — 83 of those are correctly empty forever.
3. **The retry gate is the whole design.** Get it wrong and this is a nightly 264-call no-op that reports success.
4. **The obvious gate is the wrong gate** (§5). This is the one place a reviewer is most likely to "improve" the spec into a 14% false-positive rate.
5. **Terminal markers are permanent by construction.** Marking the 83 `NO_PRIMARY_EMAIL` rows terminal is safe *only* because the condition is structural. If the primary-email derivation is ever improved — and it was, on 2026-09-07, for the `stripOwned` bug in [participants.ts:72](../src/passes/pass2/participants.ts#L72) — those markers must be cleared and re-derived. **A terminal marker records a conclusion from a version of the code, so it should carry the derivation version that set it.**
