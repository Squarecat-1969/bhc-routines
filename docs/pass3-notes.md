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

## Drift alerts are the one piece that genuinely can't be recovered standalone

Spec 3b also wants a "Drift alert if any." Unlike the task-reconciliation
counts, drift information from PASS 2's run has nowhere persistent to
recover it from — PASS 2's identity-drift detection only ever lived in that
run's in-memory `Pass2Report.warnings`, never written into any Brain_Complete
column or its own tab. This is a genuine architectural gap between "each pass
is independently runnable" (useful for testing, and how every pass has been
built and verified tonight) and the spec's own assumption that PASS 3
"re-uses data already in memory from earlier passes" (stated explicitly for
PASS 5, and implicit here too).

**Handled honestly rather than silently:** `Pass3Options` accepts an optional
`driftNotes` array, used directly when provided (i.e. when a future combined
orchestrator chains PASS 2 → PASS 3 in one process and passes the report
through). When PASS 3 runs standalone with no `driftNotes` supplied, it emits
an explicit warning saying exactly why drift can't be surfaced this way,
rather than quietly showing a digest that looks complete but is missing a
real signal. Not retroactively fixed by adding a Brain_Complete write to
PASS 2 tonight — that's real surgery on an already-live-verified pass, better
done deliberately (or via the combined orchestrator) than as a rushed
side-effect of building PASS 3.

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
drift-alert gap, never throws on a systemic failure). 342/342 across the
whole repo, typecheck clean. `npm run pass3 -- --run-id <id> --dry-run` /
`--live` exist. **Not yet run against production.**
