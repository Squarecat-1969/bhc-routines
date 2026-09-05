# contacts-mint — build notes

Step 4 of the Attio bridging work. Built 2026-09-05, dry-run only.

## What this pass is, and what it deliberately is not

It is a **planner**. It reads both systems, decides who may be minted, and emits
the exact ordered writes a mint would perform. It has **no executor**: there is
no `--live`, and `grep` for `.update(`/`.append(`/`updatePersonRecord` across
`src/passes/contacts-mint/` and `src/cli/run-contacts-mint.ts` returns nothing.
The write path is a separate build that runs only after Bobby has confirmed the
first single mint by hand.

It is also **not wired into any routine**, and must not be. The Hard Contracts:
"Automation and routines never mint a contact on their own initiative."

## Live state, 2026-09-05

| | |
|---|---|
| Master_ID max | BHC-02530 (2,484 ids over 2,505 rows; 21 rows blank) |
| Attio max | BHC-02530 (2,255 of 2,510 people carry one; 255 carry none) |
| Holder | **both** — the two systems agree today |
| Next id | **BHC-02531** |
| Master_ID-only would allocate | BHC-02531 — the same |

⚠ **The agreement is why a missing clause-1 guard is invisible.** Master_ID alone
returns the right number today. It is not wrong; it is unguarded.

Population: 2,510 people → 255 unbridged → 231 suppressed, 1 duplicate
candidate, 3 no-name, 0 no-email → **20 mint candidates**.

## Mutation checks (§5)

All four applied to the real source, run, and reverted. Every one failed a test
naming the guard it removed.

| # | Mutation | Result |
|---|---|---|
| 1 | `attioNums = []` — Attio dropped from the max computation | **4 failed** · `expected 'master-id' to be 'attio'` |
| 2 | `steps.reverse()` — Attio written before Master_ID | **3 failed** · `expected 'attio' to be 'master-id'`, and `no read-back after step 3` |
| 3 | `if (false && suppression !== null)` | **2 failed** · Raymond Yang minted a third time |
| 4 | `if (false && duplicateFlagged.has(id))` | **2 failed** · a flagged record became a candidate |

Two anti-decorative measures, because three tests across steps 1–2 passed for
reasons unrelated to the guard they named:

- Clause 1 is tested with Attio **leading**, not only with the live tie. A test
  written against the tie alone passes under mutation 1.
- The duplicate-guard negative case differs from the positive one in **exactly
  one field** (`duplicateFlagged`), so nothing else can decide the outcome.

## Why the duplicate guard blocks only one record

All 17 pending duplicate/typo rows are in the unbridged population, but 16 are
*also* suppressed, and suppression is checked first because it carries a human's
written decision. Only Patrick Suarez reaches the duplicate guard.

The guard is not therefore redundant — it is the only thing blocking him, and it
is the backstop if a `Contact_Exclusions` row is ever removed.

## ⚠ The live mint violates three clauses

`bhc-aida`'s `app/api/brain/commit/route.ts` holds the only mint in the system.
Measured against the contract:

- **Clause 1 — violated.** `nextBhcId()` reads `Master_ID!A2:A` and nothing
  else. Three call sites.
- **Clause 2 — violated, reversed.** `handleReStamp` PATCHes Attio first and
  appends Master_ID afterwards.
- **Clause 5 — violated.** On an append failure it pushes a *warning* and
  returns `ok: true, result: "minted"`. That is the silent orphan — a stamped
  record with no bridge row — reported as a success.

Not changed in this build: fixing a live identity-write path is not a dry-run
action.
