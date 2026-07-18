# PASS 4.5 — implementation notes, assumptions, and open questions

Companion to `src/passes/pass4_5/`. Same purpose as `docs/pass4-notes.md`: every
place the spec (`routines/BHC_Late_Edition.md`, PASS 4.5 section) was ambiguous,
silent, or where building this standalone (rather than chained after a live PASS 4
run in the same process) required a judgment call.

**Status: first live dry run confirmed clean, 2026-07-18.** 2,216/2,216 records
fetched with zero failures and zero retries; 0 identity mismatches; 0 unresolved;
the 4.5h suppression logic correctly held back 11 real name-drift candidates that
already have pending Reconciler-sourced cards. 38 integration/unit tests still pass
(111/111 across the whole repo), typecheck clean. **The one open item is runtime
tuning (below) — everything else read-side is proven. Not yet run `--live`.**

---

## 1. Batch size for the 4.5b bulk fetch — proven clean at 10, but slow; now tunable

Spec says "Batch in groups of 50." This code defaults to `ATTIO_FETCH_BATCH_SIZE = 10`
and `ATTIO_FETCH_BATCH_PAUSE_MS = 2000`, reused from PASS 4's proven values.

**Why reused rather than raised to match the spec's "50":** the spec's "50" was
written assuming a true bulk `get-records-by-ids` call (one request, 50 records). Our
REST transport has no bulk endpoint — `fetchPersonRecordsBatched` (`src/lib/attio.ts`)
does N parallel single-record GETs per batch instead (see that file's own doc comment
for the full deviation rationale). A batch of 50 there means 50 *concurrent* GET
requests, not one cheap call — a real difference in load on Attio's rate limiter that
the spec's number doesn't account for.

**✅ First real dry run, 2026-07-18** (`npm run pass4_5:dry`, default batch=10):
2,216/2,216 person records fetched, **zero failures, zero retries** (no retry
warnings anywhere in the log — every single-record GET succeeded on the first try).
0 identity mismatches, 0 unresolved. Total wall time: **~11m19s**, almost entirely in
the fetch loop. That's over half of the GitHub Actions job's 20-minute timeout, for
this pass alone — a real constraint once this runs alongside PASS 4 and whatever
comes after it in the migration order.

Zero failures/retries at batch=10 is exactly the signal that there's headroom to
raise concurrency. `--batch-size` and `--pause-ms` are now CLI flags
(`npm run pass4_5 -- --dry-run --batch-size 25 --pause-ms 1000`) so this can be tuned
empirically without a code patch each time — run a dry run at a higher setting, check
whether failures/retries stay at zero, and use whatever wall-clock time is comfortable
against the 20-minute budget once this is wired into CI.

> **Decision needed:** pick a batch size/pause via a few empirical dry runs (dry-run
> writes nothing, so this carries zero data risk) rather than guessing at one number
> now — try e.g. 20 and 30 and compare failure/retry counts and wall time.

---

## 2. Tab guard (4.5.0) treats ANY read error as "tab absent"

Spec: "Read `Pipeline_Cache!A1:R1`. If it errors (tab missing) → ... skip the entire
pass." Implemented literally: the `try/catch` around that one read treats every error
— a genuinely missing tab, but also a transient network blip, an auth failure, a
malformed range — as "tab absent, skip."

**Risk:** a real outage (e.g. `BRAIN_API_TOKEN` briefly invalid) would be
misreported as "tab absent" rather than a proper abort, which could read as
misleadingly benign in a log or Slack line ("PIPELINE_CACHE: tab absent — skipping"
sounds like an intentional, expected state, not a failure).

**Chosen:** matched the spec's literal wording rather than trying to distinguish
error types by parsing the Sheets proxy's error body, which isn't a documented,
stable contract to parse against. If this ever misfires in practice (tab-absent
skip messages showing up when the tab demonstrably exists), that's the signal to
add real error-type discrimination here.

---

## 3. Google tier reuse — one shared wide Contacts read, not two

Spec says H Relationship_Tier uses "tier_index.get(bhc_id) (Google, from PASS 4b)."
Since PASS 4 and PASS 4.5 run as separate CLI invocations right now (no combined
Late Edition entrypoint exists yet in `src/`), there's no literal in-memory
`tier_index` to reuse from a prior pass.

**Chosen:** `src/passes/pass4_5/contacts.ts`'s `loadContactsWide` resolves
Relationship_Tier, Primary_Email, and Effective_Segment in **one** wide Contacts
read, rather than calling PASS 4's `loadTierIndex` (a second full-width read of the
same sheet just for the tier column) and then a third read for email/segment.
Produces an identical tier value to what PASS 4's own tier index would — same
column, same normalization (`normalizeTier`) — just fetched once instead of twice.

---

## 4. Pipeline entries — independently fetched unless passed in

Spec: "Reuse PASS 4's pipeline_entries (don't re-fetch)." `runPass45` accepts an
optional `pipelineEntries` parameter for exactly this reuse, but since there's no
combined runner yet, the CLI (`run-pass4_5.ts`) never passes one — PASS 4.5 always
independently calls `attio.listEntries()` when run standalone. Once a combined
Late Edition entrypoint exists (chaining PASS 4 → PASS 4.5 → ...), it should pass
PASS 4's already-fetched entries through to avoid the redundant list call. Cheap
list (~44 entries, one page) either way, so this is a minor inefficiency, not a
correctness issue.

---

## 5. A full withhold still clears a stale prior cache

Not a spec ambiguity — a real bug caught by a test before it ever ran live. Early
version only wrote/blanked when `rows.length > 0`, meaning if every target were
withheld in a single run (e.g. a bad batch of identity mismatches), a previous
night's cache would be left untouched instead of cleared — silently stale data
masquerading as current. Fixed: blanking now runs whenever the prior cache had more
rows than this run does, independent of whether this run wrote any main block at
all. Covered by `tests/pass4_5/pass4_5-integration.test.ts` ("clears a stale prior
cache even when every target is withheld").

---

## 6. Not built yet (deliberately out of scope for this step)

- **A combined Late Edition entrypoint** chaining PASS 0 → 5 in one process/run. Each
  pass still runs via its own CLI (`run-pass4.ts`, `run-pass4_5.ts`) with its own
  dry-run default. Building the chain is a later step in the migration order (after
  1+0 and 2 exist).
- **GitHub Actions wiring.** `.github/workflows/late-edition.yml` currently only runs
  PASS 4. PASS 4.5 isn't wired into CI yet — that's an integration decision to make
  once more passes exist, not before.
