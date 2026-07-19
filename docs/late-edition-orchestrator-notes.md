# The combined Late Edition orchestrator — implementation notes

Companion to `src/passes/orchestrator/`. Chains all eight already-tested,
individually-live-verified passes into one process, sharing one `Run_ID`,
instead of eight separate CLI invocations with a `Run_ID` copied by hand.

**Status: built and tested (9 tests, including a full 8-pass chain against
fake backends), not yet run against production.**

---

## Deliberately shallow, not a rewrite

This does NOT restructure any individual pass's internal Sheets/Attio reads
to share fetched data in memory (Master_ID, Contacts, etc.) across passes.
Every pass already does its own independent, already-live-verified reads.
Touching that machinery for marginal efficiency gain is real risk on code
that's currently working correctly in production — not worth it.

The one piece of real in-memory data sharing this orchestrator *does* do is
narrow and deliberate: PASS 2's identity-drift warnings feed directly into
PASS 3's digest (`drift-notes.ts`) — the one genuine gap documented in
`docs/pass3-notes.md` that standalone operation could never close on its
own, since PASS 2's drift detection only ever lived in that run's in-memory
report, never persisted anywhere.

## A real inconsistency found while wiring this up

PASS 4's report has no `aborted` field at all — every other pass does,
including its own sibling PASS 4.5. PASS 4's fail-soft is purely per-contact
(withheld rows), not per-run, and its existing standalone CLI already posts
the Slack addendum *unconditionally* rather than gating on any run-level
failure state. This orchestrator matches that established behavior exactly
for both PASS 4 and PASS 4.5 — always post when live — rather than inventing
new gating logic PASS 4's own CLI never had. Worth reconciling the shapes
someday; not fixed here, since changing PASS 4's report shape is real
surgery on an already-live-verified pass for a purely cosmetic gap.

## Fail-soft, one more layer

Every individual pass already returns an `aborted` report rather than
throwing. This orchestrator adds one more layer of defense anyway
(`runStage`, wrapping each stage in a try/catch with a synthesized abort
report on the way out) — not because any pass has ever been observed to
throw unexpectedly, but because an 8-pass unattended chain is exactly the
kind of place where "should never happen" is worth guarding against for
real, rather than trusting it.

## A real, valuable finding from building the integration test — not a bug

The first version of the "does PASS 2's write actually reach PASS 3" test
used `dryRun: true` for both sides and failed: PASS 3 saw zero rows. Traced
it down expecting a bug in either pass — instead found the dry-run guarantee
working exactly as designed. PASS 2 gates its actual `sheets.append()` call
behind `if (!dryRun)`; `writtenCount` still increments in dry-run for
reporting purposes ("what would have been written"), but nothing is
actually persisted. A dry-run write being invisible to a later read isn't a
bug to fix — it's the safety property this whole rebuild has been built
around, now confirmed to hold even under a full 8-pass chained run, not
just each pass in isolation. Fixed the test, not the code: the real
data-flow tests run `--live` against the fake backend, which is the only
way to genuinely test cross-pass persistence.

## The fake backend needed a real capability it never had before

No single pass's own test ever needed a write from one call to be visible
to a *later* read within the same test — each pass's tests either only
write (checking shape via `sheetsWrites`) or only read, never both against
the same tab in sequence. A genuine cross-pass integration test is the
first scenario that actually needs this. Added targeted, minimal state to
`FakeBackend`: an `append` to a `Brain_Complete` range now actually mutates
`this.config.brainComplete`, so a subsequent read reflects it — matching
real Sheets' actual behavior, scoped narrowly to the one tab that currently
needs it rather than rewriting every tab's write handling speculatively.

## First live run (2026-07-19, --dry-run --limit 3) — clean, zero aborts, one real gap found

All eight passes ran back to back against real production data — real
Contacts (2855 rows), real Master_ID (2450 rows), real Attio pipeline (44
entries), real open tasks (83, clustered to 79), real Thread_Staging (500
rows, 0 in tonight's working set — no new mail since the last test run).
Every pass completed with `aborted: false`. ~37 seconds end to end with
`--limit 3` applied to the passes that support it.

**One real gap, found by reading the combined summary carefully**: the
report never surfaced any pass's own `warnings` array. Each pass's own
standalone report always has included this (it's how the `max_tokens`
diagnostic and drift warnings earlier tonight were visible at a glance) —
the combined report silently dropped it. Warnings still appeared in the
live log stream (each pass logs its own via the shared logger), but the
"read this and know if something needs attention" summary at the bottom
had nothing to say about them. Fixed: `collectWarnings` aggregates every
pass's warnings, prefixed by pass name, into a `WARNINGS (N):` section —
present only when there's actually something to say. 3 new tests.

This run itself had zero warnings to surface, so the gap didn't show up
in this particular run's output — found by reasoning about what *would*
happen on a run that did have one, not by observing a missed warning
directly.

## Status

9 tests: 3 for `extractDriftNotes` (pulls only identity-drift warnings,
handles no-warnings and empty-report cases), 6 for the full orchestration —
one shared `Run_ID` across all eight reports, a clean run against a fully
empty dataset, a real thread genuinely flowing from PASS 2's write into
PASS 3's digest (the fake-backend statefulness fix), the drift-notes flow
working end to end (the actual point of this whole orchestrator), Slack
addenda posting live and staying silent in dry-run. Plus 3 more for the
warning-aggregation fix below. 403/403 across the whole repo, typecheck
clean. `npm run late-edition -- --dry-run --limit N` / `--live` exist.

**Run once against real production data** (`--dry-run --limit 3`): all
eight passes completed cleanly, zero aborts, ~37 seconds end to end. One
real gap found and fixed (warnings weren't surfaced in the combined
summary — see above). **Not yet run `--live`, and not yet run without a
`--limit`** — a full unlimited run (all ~79 PASS 2.5 clusters, all Attio
pipeline entries for PASS 4/4.5) will take considerably longer than 37
seconds; worth setting that expectation before the first unlimited run.
