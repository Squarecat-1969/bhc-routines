# PASS 2.5 — Task Reconciliation — implementation notes

Companion to `src/passes/pass2_5/`. Mirrors the other passes' notes format.

**Status: fully built and tested (40 tests), not yet run against production.**

---

## Live reconnaissance before writing any code

Same discipline as every pass before it. Checked all relevant tabs against
real data before assuming anything:

- **`Tasks_Open`** — confirmed exact match with the spec (13 cols, A-M).
  Memory's "Tasks_Log" reference was simply stale — the real tab has always
  been `Tasks_Open`.
- **`Reconciliation_Queue`** — already verified back in the PASS 0 session
  (2026-07-18): `Item_Type`, `Source_Task_ID`, etc. all confirmed live then.
  Reused here directly.

## Why the LLM call is narrower than the spec's literal three verdicts

Spec 2.5d lists three verdicts (`LIKELY_HANDLED_EVIDENCE`,
`LIKELY_STALE_NO_EVIDENCE`, `GENUINELY_OPEN`). Only the first genuinely needs
judgment — the other two are a pure function of "no evidence found" plus
`Due_Date` vs. today (`>7 days past` or not). Asking the model to also do
that date arithmetic would be pointless risk for zero benefit — a wrong
`>7 days` calculation from an LLM is a bug a human wouldn't catch by reading
the output, since it looks like a reasonable judgment call rather than
arithmetic gone wrong.

**Split cleanly:** `reconcile.ts`'s LLM call answers exactly one question —
does a candidate interaction genuinely satisfy the request? If yes:
`LIKELY_HANDLED_EVIDENCE`, with the model's own quote/confidence/reasoning.
If no: a pure TypeScript function (`resolveNoEvidenceVerdict`) decides
`STALE` vs `OPEN` from `diffDays` alone. Same principle as PASS 2's
`outcome` field being a real judgment call while `Reply_Mode`
(`individual`/`group`) is deterministic arithmetic, not asked of the model.

**Zero candidates → zero LLM calls.** If the deterministic pre-filtering in
`activity-candidates.ts` leaves nothing to evaluate, `reconcileCluster`
skips the API call entirely and goes straight to the date-math verdict —
same "don't spend a call on something with a knowable answer" instinct as
PASS 2's `noise:internal` filter.

## A real safety property, not just a passing test

`reconcileCluster` verifies the model's claimed `evidence_activity_id`
actually appears in the candidate list it was given — never trusts a
model-cited ID blind. If the model hallucinates an ID (or cites something
outside what it was shown), the whole cluster's reconciliation is treated as
failed rather than silently accepting fabricated evidence. Tested directly:
a hallucinated ID produces a warning and zero handled-count, not a false
`LIKELY_HANDLED_EVIDENCE`.

## Clustering is deliberately conservative

Spec 2.5b: *"Same underlying request across channels = ONE cluster... When
in doubt, keep SEPARATE."* No algorithm is given. Implemented as literal
equality after normalization (lowercase, strip punctuation, collapse
whitespace) for the same contact — not a fuzzy similarity score. A
similarity-based clusterer would risk merging genuinely distinct requests,
which is the worse failure per the spec's own stated preference. Tested:
near-identical descriptions for the same contact merge; merely-similar
descriptions ("send the contract" vs. "send the invoice") stay separate.

## SUPERSEDE-IN-PLACE, read literally

"In-place" means an existing *awaiting* (blank `Status`) row whose
`Source_Task_ID`s overlap gets its own row **updated**, keeping the same
`Recon_ID` — not superseded by a fresh appended row. Only a cluster with no
overlapping awaiting row gets a genuinely new `Recon_ID`. "Write only on
material change" is enforced before either path: if the newly computed
verdict is identical to what's already there (verdict, evidence quote,
confidence, proposed date all unchanged), nothing gets written at all.

## Two things flagged rather than guessed past

1. **"Contact matches (by BHC_ID, name, or email)" — email matching isn't
   implemented.** Activity_Log candidates don't carry an email field
   directly (only `Contact_ID`/`Contact_Name`), so the email leg of this
   three-way match isn't reachable from the data actually available at this
   point in the pipeline. Matches on BHC_ID or name only. Not expected to
   matter much in practice (most Activity_Log rows have a resolved BHC_ID),
   but worth knowing if reconciliation seems to miss a candidate that should
   have matched by email alone.
2. **`resolveNoEvidenceVerdict`'s date math uses `diffDays(today, due)`**,
   i.e. today minus due-date — positive means overdue. Not yet checked
   against a real overdue task in production; the unit tests cover both
   sides of the 7-day boundary with synthetic dates, but the first live run
   is the real confirmation.

## First live dry run (2026-07-19, sharing Run_ID with a real PASS 2 run)

Ran against 83 real open tasks, 79 clusters, 695 real Activity_Log rows. Real
findings:

- **Reasoning quality is genuinely strong**, not just structurally valid.
  The model consistently and correctly recognized that a `"Closed from
  queue"` log entry is an *administrative* dismissal, not proof of actual
  completion — a distinction that showed up dozens of times and never
  fooled it. One real evidence match (Sarah Holmes reviewing a response
  letter) was correctly downgraded to `medium` confidence rather than `high`
  because the evidence showed her reviewing the letter, not that the
  specific phone call the task described actually happened — the HARD GATE
  distinguishing "topically related" from "genuinely satisfies" working
  exactly as designed on a real, subtle case.
- **SUPERSEDE-IN-PLACE confirmed against genuine historical data**: 34 rows
  updated in place against real `Reconciliation_Queue` rows left over from
  the old agentic system, not just fresh appends.
- **One real failure, fail-soft caught it correctly** (1 of 79 clusters):
  `"Anthropic response had no text content — unexpected shape"` — but the
  error carried no diagnostic detail to actually debug it if it recurred.

**Fixed** (in `src/lib/anthropic.ts`, shared by PASS 2 and PASS 2.5):
the "no text content" error now includes `stop_reason` and the actual block
types present in the response — and distinguishes a genuinely missing
`content` array from one that's present but empty, since the first version
of this fix conflated the two. 3 new tests in a new `tests/anthropic.test.ts`
(previously untested as its own unit, only exercised indirectly through
PASS 2/2.5's integration suites).

## Status

40 unit/integration tests plus 3 shared-client tests (in `tests/anthropic.test.ts`,
counted separately since they cover the shared library, not this pass alone) —
pure-logic: clustering, candidate filtering, schema validation, supersede-in-place
logic; full end-to-end orchestration against fake Sheets+Anthropic backends
together — evidence-found, no-evidence date math on both sides of the 7-day
boundary, hallucination rejection, supersede vs. append vs. no-write-on-no-change,
dry-run, fail-soft. 387/387 across the whole repo, typecheck clean. `npm run
pass2_5:dry` / `npm run pass2_5:live` exist, plus `--run-id` to share a Run_ID
with a specific PASS 2 run.

**Run once against real production data**: 83 open tasks, 79 clusters, 695
Activity_Log rows, reasoning quality confirmed strong on real edge cases, one
real failure diagnosed and fixed (see above). Not yet run `--live` (only
`--dry-run` so far).
