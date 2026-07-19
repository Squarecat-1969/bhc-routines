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

## First live dry run (2026-07-19) — real data confirmed correct, one real bug found and fixed

Ran against real production data: 83 open tasks, 14 real `Brain_Complete`
rows, 44 real Attio pipeline entries (batched fetch confirmed working —
`10/44 → 20/44 → 30/44 → 40/44 → 44/44`), `Zoom_Staging`'s corrected status
column. Mission status, counts, and the generated brief text all checked out
correctly on real data, including a real cross-check with PASS 2.5's own
finding that night (`nextTouch=Ryan Crisman` in the TNB mission-status
block matched a task PASS 2.5 had independently flagged).

**One real bug, found by actually reading the output**: a plan item's reason
text read `"Overdue since 46162 — High priority"` — a raw Excel/Sheets date
serial (days since 1899-12-30) leaking verbatim into Bobby-facing text,
instead of a real date. The underlying `Due_Date` cell had been read/stored
as a number rather than an ISO string for this particular task.

**Root cause, once traced**: `buildBucket1` already correctly parsed the due
date via `parseFlexibleDate` for its own `daysOverdue` math (which is why
the task was correctly identified and sorted as overdue at all) — but then
discarded that parsed value and re-embedded the *raw* `t.dueDate` string
into both the `reason` text and the `dueDate` output field. **Fixed**: the
already-parsed `CivilDate` is now carried through and rendered via `iso()`
for both fields, so the display is always a clean `YYYY-MM-DD` regardless of
how the source cell was shaped.

**Same bug class found and fixed in PASS 2.5 too**, before it ever surfaced
there: `clusterOpenTasks`' `latestDueDate` computation used a raw
lexicographic string sort across a cluster's due dates. A numeric serial
like `"46162"` sorts *after* `"2026-07-20"` purely alphabetically (`"4" >
"2"`), regardless of which one is actually the later calendar date — so a
mixed cluster could have picked the wrong "latest" due date, and that raw
value would have been written directly into `Reconciliation_Queue`'s
`Proposed_Completion_Date` column for Bobby to see. Fixed the same way:
parse first, sort by actual date value, render via `iso()`.

2 new regression tests (one per pass) reproducing the exact `"46162"` shape
found live.

## A size-safety guard, added from a real question, not a real incident

Bobby asked directly: does Google Sheets have a per-cell character limit,
and does writing the whole `game_plan` into one cell make sense given that?
Confirmed via search: Sheets has a hard, non-adjustable 50,000-character
limit per cell. Today's real writes come in well under 1,000 characters,
and the plan's own design (hard-capped at 10 items, each field naturally
bounded — a `response_draft` is already constrained to a few sentences by
PASS 2's own prompt) means realistic worst-case size is a small fraction of
the limit.

**Kept the one-cell design rather than subdividing** — the spec's insistence
on "the ONLY valid write shape" (repeated three times: "NEVER iterate...
NEVER write individual keys as separate rows... NEVER write more than 2
columns") reads as protecting a downstream contract, not just being
cautious. Aida's own web app almost certainly reads this one cell and parses
it as a single JSON blob; splitting it would require coordinated changes on
the Aida side for a problem the plan's own bounded design doesn't actually
create.

**Added instead**: a size check before writing. If the serialized JSON ever
exceeds a 45,000-character safety margin (leaving room below Sheets' actual
50,000 limit), `writeDailyBrief` refuses to write and returns a clear reason
rather than risking silent truncation or an API rejection — the same "stop
silently, don't write a broken shape" instinct the spec already uses
elsewhere in this step, just extended to a failure mode (an oversized blob)
the spec itself didn't anticipate. `writeDailyBrief`'s return type changed
from `Promise<void>` to a discriminated `DailyBriefWriteResult`
(`written: true` or `written: false` with a reason) so the orchestration can
distinguish "refused due to size" from "genuinely wrote" rather than
collapsing both into a boolean. 2 new tests (refusal path, normal-size
success path).

## Status

40 tests (mission status — per-track independence, multi-track membership,
the FTE-only `daysSinceTouch` field, overdue-first tie-break; counts — the
two different date comparisons; plan — all four buckets' filters and caps,
the dedup/trim/priority-numbering assembly, the numeric-date-serial
regression test; brief text — the exact all-clear string, singular/plural
phrasing, no markdown; `Daily_Brief`'s exact one-row-two-column write shape
including the update-in-place case and the size-safety guard; and a full
orchestration suite against fake Sheets+Attio together). 391/391 across the
whole repo, typecheck clean. `npm run pass5 -- --run-id <id> --dry-run`/
`--live` exist.

**Run against real production data**: 83 open tasks, 14 real Brain_Complete
rows, 44 real Attio pipeline entries, real `Zoom_Staging` count. Mission
status, counts, and brief text confirmed correct. One real bug found and
fixed (a numeric date serial leaking into display text), plus the same bug
class caught and fixed in PASS 2.5 before it surfaced there too. **Not yet
run `--live`** (`--dry-run` only so far — the fix isn't yet reverified
against a fresh live run).
