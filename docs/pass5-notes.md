# PASS 5 — Game Plan Generation — implementation notes

Companion to `src/passes/pass5/`. Mirrors the other passes' notes format.

**Status: fully built and tested (36 tests), not yet run against production.
This is the last of the eight passes — the full Late Edition rebuild is now
built end to end.**

---

## The big reuse win: PASS 4's cadence functions, not re-derived

Spec 5a says to "re-use data already in memory from earlier passes" for
`pipeline_entries`, `cadence_results`, and `tier_index`. PASS 5 runs as its
own CLI invocation (same reasoning as PASS 3), so there's no literal shared
memory to reuse — but there's something just as good: PASS 4's
`evaluateContact` (the exact function that computes cadence for real, already
tested, already live-verified against production) was only ever a private
detail of PASS 4's own module. Exported it (a purely additive change, zero
behavior change — confirmed by rerunning PASS 4's full test suite
afterward) and PASS 5 calls it directly on a fresh, read-only Attio fetch.
Same for `fetchRecords`. This means PASS 5's cadence math isn't a second,
parallel implementation that could drift from PASS 4's — it's *literally the
same code path*, just invoked read-only from a different pass.

## Mission status needs data `CadenceRow` doesn't carry

Spec 5b's `track_entries(track_key)` needs to know, independently, whether
each pipeline entry has a stage ≥1 in *that specific track* — TNB, FTE, and
Fractional separately. `CadenceRow` only carries the *winning* track for a
contact's overall cadence (a contact active in both TNB Stage 3 and FTE
Stage 1 resolves to `activeTrack: 'TNB'` for cadence purposes, per the
TNB > FTE > Fractional tie-break). So `mission-status.ts` derives its own
lightweight `PipelineEntryStages` (the three raw stage strings per entry)
directly from each Attio pipeline entry, and uses it purely for track
*membership* — the `stalled`/`nextCheckIn` values used once membership is
established still come from the shared `CadenceRow`, never recomputed.

## Two count comparisons that look inconsistent but are transcribed exactly

`tasksOverdue` (5c) uses strictly-before-today; `pipelineTouches` uses
on-or-before-today. A task due today isn't overdue yet; a pipeline touch due
today already needs doing. Kept exactly as the spec's own pseudocode has it
rather than normalized to match each other — worth knowing if a "1 vs 0"
discrepancy shows up when comparing counts against a task/touch that's due
exactly today.

## A real spec ambiguity in 5d, resolved and documented (not silently picked)

Buckets 1 and 3 each state their own specific sort right in their
definition. A separate "Ranking" paragraph gives a different, more generic
3-key sort ("active pipeline stage desc, days overdue desc, tier rank") that
literally says "within each bucket" — appearing to contradict the specific
sorts just given. Read together with the sentence immediately following it
("Fill bucket slots in order, dedup by bhcId..., Assign priority 1-N
sequentially after merging and trimming to 10"), this reads as describing
the *final cross-bucket assembly*, not a second per-bucket sort. Resolved as:
each bucket's own explicit sort governs which candidates fill its slots
(implemented exactly — bucket 1 by days-overdue descending, bucket 3 by
stalled-then-days-since descending); the generic rule's real, unambiguous
work — dedup by `bhcId` keeping first occurrence (buckets are filled in
priority order, so first-occurrence-wins *is* "keep highest-priority"), trim
to 10, number 1..N — happens once across the merged pool. Buckets 2 and 4
have no bucket-specific sort stated at all, so they're simply taken in
`Brain_Complete` row order up to their slot caps.

## Status

36 tests (mission status — per-track independence, multi-track membership,
the FTE-only `daysSinceTouch` field, overdue-first tie-break; counts — the
two different date comparisons; plan — all four buckets' filters and caps,
the dedup/trim/priority-numbering assembly, one real test bug caught and
fixed along the way (four tasks sharing a default contact collapsed to one
via dedup — correct code, wrong test fixture); brief text — the exact
all-clear string, singular/plural phrasing, no markdown; `Daily_Brief`'s
exact one-row-two-column write shape including the update-in-place case; and
a full orchestration suite against fake Sheets+Attio together). 384/384
across the whole repo, typecheck clean. `npm run pass5 -- --run-id <id>
--dry-run`/`--live` exist. **Not yet run against production.**
