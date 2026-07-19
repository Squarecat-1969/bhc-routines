# PASS 3 — Slack digest to #aida — implementation notes

Companion to `src/passes/pass3/`. Mirrors the other passes' notes format.

**Status: fully built and tested (19 tests), not yet run against production.**

---

## Why `--run-id` is required, unlike every other pass

Every other pass generates its own fresh `RUN_ID` at the top of its run.
PASS 3 can't — its whole job is to re-read and digest a *specific prior*
run's `Brain_Complete` output (spec 3a: "Re-read Brain_Complete!A:AD filtered
to rows where col AB == RUN_ID"). So the CLI requires `--run-id` explicitly,
with a clear error message pointing at where to find it (a PASS 2 run's log
line, or `Brain_Complete` column AB directly).

## The task-reconciliation line doesn't require chaining with PASS 2.5

Spec 3b calls for "Task reconciliation line (2.5f)" in the digest, and 2.5f's
counts live in PASS 2.5's own in-memory report — which PASS 3, run as a
separate CLI invocation, doesn't have access to. Rather than requiring PASS 3
to be chained with PASS 2.5 in one process, `task-reconciliation-line.ts`
independently re-derives the H/S/O counts by reading `Reconciliation_Queue`
filtered by this run's `Run_ID` (col B) and counting by `Verdict` (col H) —
the same tab PASS 2.5 already wrote to. Keeps PASS 3 genuinely standalone
without losing any real data.

**Real finding from live data (2026-07-19): the counts mean "changed
tonight," not "the full current backlog," and that's correct — but worth
being explicit about.** PASS 2.5's own report showed `handled=4 stale=62
open=13` (79 total) after recomputing every open task fresh. But PASS 3's
digest showed `4 likely handled · 22 likely stale · 11 still open` (37
total) for that same run. The gap isn't a bug: PASS 2.5's "write only on
material change" rule means most of those 79 freshly-computed verdicts
*matched* what was already correctly sitting in `Reconciliation_Queue` from
earlier writes, so nothing got written and those rows kept whichever
`Run_ID` last actually touched them (sometimes an older run, sometimes
never touched at all if the row predates the TypeScript rebuild). PASS 3
only counts rows genuinely tagged with *this* run — so the digest is
reporting **"what's newly reconciled or changed tonight,"** not the total
backlog. That's the right behavior for a nightly digest (Bobby shouldn't see
the same 40+ unchanged items re-listed every night forever), but it's a
real distinction worth understanding: **the digest's task-reconciliation
line will generally under-report the true total open-reconciliation count**,
by design, not by omission.

## Drift alerts — standalone can't recover them; the combined orchestrator does

Spec 3b also wants a "Drift alert if any." Unlike the task-reconciliation
counts, drift information from PASS 2's run has nowhere persistent to
recover it from — PASS 2's identity-drift detection only ever lived in that
run's in-memory `Pass2Report.warnings`, never written into any Brain_Complete
column or its own tab. This is a genuine architectural gap between "each pass
is independently runnable" (useful for testing, and how every pass was
built and verified) and the spec's own assumption that PASS 3 "re-uses data
already in memory from earlier passes" (stated explicitly for PASS 5, and
implicit here too).

**Handled honestly rather than silently:** `Pass3Options` accepts an optional
`driftNotes` array, used directly when provided. When PASS 3 runs standalone
with no `driftNotes` supplied, it emits an explicit warning saying exactly
why drift can't be surfaced this way, rather than quietly showing a digest
that looks complete but is missing a real signal.

**Resolved by the combined orchestrator** (`src/passes/orchestrator/`,
`docs/late-edition-orchestrator-notes.md`): PASS 2's identity-drift warnings
now flow directly into PASS 3 in memory when chained. Building and running
that chain at real production scale surfaced two real bugs in exactly this
mechanism — see below.

## Two real bugs found on the orchestrator's first full-scale live run (2026-07-19)

The combined orchestrator's first unlimited `--dry-run` (all 79 PASS 2.5
clusters, all 2216 PASS 4.5 targets, real Attio/Sheets throughout) surfaced
a warning that shouldn't have fired: `[PASS 3] drift alerts require
chaining directly with PASS 2's in-memory report — running PASS 3 standalone
means any drift this run had is not surfaced in the digest.` — except PASS 3
was *not* standalone. The orchestrator explicitly passed `driftNotes`
(genuinely empty, since PASS 2 found zero drift that run).

**Bug 1**: `runPass3Inner` destructured `driftNotes = []` before checking
whether the warning should fire, then checked `driftNotes.length === 0`.
That collapses two genuinely different situations into the same value:
"never given a `driftNotes` array at all" (truly standalone, no way to know
if there was drift) and "given an array that happens to be empty" (chained,
and PASS 2 genuinely found nothing). **Fixed**: check `opts.driftNotes ===
undefined` before applying any default — the type was already correctly
optional (`driftNotes?: readonly string[]`), the bug was purely in how the
destructuring default collapsed the distinction before the check ran.

**Bug 2, found while fixing Bug 1**: even with the check fixed, a
genuinely non-empty `driftNotes` array chained into a night where nothing
else happened to surface would still never show up — `buildDigestBody`'s
`all_clear` path returns early, entirely before the drift-notes rendering
code. Identity drift is a *standing data-integrity flag*, not a "new item
tonight" — it shouldn't disappear just because no email needed a reply that
same night. **Fixed**: the `all_clear` path now renders the drift line too,
when present, before returning.

Both bugs were real and would have fired on every actual production run
with a clean PASS 2 (i.e. most nights) — a false "you're not chained"
warning that would train Bobby to ignore it, plus real drift silently
vanishing on any all-clear night. 4 new tests (2 confirming the warning
distinguishes the two cases correctly, 2 confirming drift notes survive
the all_clear path when present and stay absent when genuinely empty).

## The empty-body HARD GATE (spec 3c) is three genuinely different outcomes

Not just "did the digest work" — `buildDigestBody` returns one of three
distinct kinds:
- **`valid`** — at least one surfaced (actionable) row. Normal digest,
  numbered blocks, footer.
- **`all_clear`** — zero actionable rows. A legitimate, expected outcome on
  a quiet night, with its own message ("Nothing needs your attention
  tonight. ✅") — explicitly *not* treated as a failure.
- **`failure`** — the digest body ends up empty despite there being rows to
  report on. Per spec, "DO NOT POST A STUB" — this triggers a distinct
  failure alert instead of the normal post. In practice this can only fire
  from a genuine internal bug in the renderer itself (the renderer always
  produces at least a header+count line when there are rows), so it's a
  defensive check, not a code path expected to trigger in normal operation.

## Spec 3e's "verify the send carried a body" doesn't map onto this transport

The spec's exact language ("200 alone is NOT proof... verify the send
carried a body") reads like it assumes a richer API response than a Slack
incoming webhook actually returns — webhooks just return literal `"ok"` text
on success or an error status on failure, with no message body to inspect
for emptiness. The underlying `SlackPoster` (`src/lib/slack.ts`) already
retries transient HTTP failures at the request layer. PASS 3 implements the
spec's real *intent* — never silently swallow a failed post — by catching
any error that survives those retries and posting a distinct failure alert
in its place, rather than trying to invent a "body" check for a transport
that doesn't have one.

## Status

19 tests (digest assembly covering all three outcome kinds plus drift/task-line
inclusion, the two Run_ID-filtered readers, and a full orchestration suite —
normal digest posts once, dry-run posts nothing, all-clear posts the
all-clear message, a Slack failure triggers the retry-then-alert path, only
the specified run's rows are ever included, standalone runs warn about the
drift-alert gap correctly (and chained runs with genuinely zero drift don't
falsely warn), drift notes survive the all_clear path, never throws on a
systemic failure). 407/407 across the whole repo, typecheck clean. `npm run
pass3 -- --run-id <id> --dry-run` / `--live` exist.

**Run against real production data multiple times, including through the
combined orchestrator at full scale**: digest assembly correct on real
Brain_Complete rows every time — numbered blocks, action labels, the
`REPLY_NEEDED` draft, footer, pluralization all confirmed. Real finding on
the task-reconciliation line's meaning (documented above), and two real
bugs found and fixed in the drift-notes mechanism specifically (documented
above). **Not yet actually posted to `#aida`** (`--dry-run` only so far).
