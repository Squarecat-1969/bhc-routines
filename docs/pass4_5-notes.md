# PASS 4.5 — implementation notes, assumptions, and open questions

Companion to `src/passes/pass4_5/`. Same purpose as `docs/pass4-notes.md`: every
place the spec (`routines/BHC_Late_Edition.md`, PASS 4.5 section) was ambiguous,
silent, or where building this standalone (rather than chained after a live PASS 4
run in the same process) required a judgment call.

**Status: fully verified read-side and performance-tuned, 2026-07-18.** 2,216/2,216
records fetched with zero failures/retries at three different batch settings; 0
identity mismatches; 0 unresolved; the 4.5h suppression logic correctly held back 11
real name-drift candidates that already have pending Reconciler-sourced cards.
Default fetch pacing settled at batch=40/pause=1000ms (~2m15s at full scale, down
from ~11m19s). 38 integration/unit tests still pass (111/111 across the whole
repo), typecheck clean. **Everything in this doc is now resolved. Not yet run
`--live`** — that's the next and last step before PASS 4.5 is trustworthy
end-to-end, same gate PASS 4 went through.

---

## 1. Batch size for the 4.5b bulk fetch — ✅ RESOLVED 2026-07-18: batch=40, pause=1000ms

Spec says "Batch in groups of 50." This code's default is now `PASS4_5_FETCH_BATCH_SIZE
= 40` / `PASS4_5_FETCH_PAUSE_MS = 1000` (`src/config/constants.ts`) — its own tuned
values, no longer PASS 4's.

**Why not PASS 4's constants:** the spec's "50" assumes a true bulk
`get-records-by-ids` call (one request, 50 records). Our REST transport has no bulk
endpoint — `fetchPersonRecordsBatched` (`src/lib/attio.ts`) does N parallel
single-record GETs per batch instead. PASS 4's `ATTIO_FETCH_BATCH_SIZE = 10` was tuned
for its own ~44-record scale; reusing it for PASS 4.5's ~2,213 records was needlessly
conservative.

**Three real dry runs against production (2026-07-18), all clean:**

| Batch / Pause | Wall time | Failures | Retries |
|---|---|---|---|
| 10 / 2000ms (PASS 4's original default) | ~11m19s | 0 | 0 |
| 25 / 1000ms | ~3m23s | 0 | 0 |
| 40 / 1000ms | ~2m15s | 0 | 0 |

Zero failures and zero retries at every level tested — no sign of Attio's rate
limiter pushing back even at 40 concurrent requests. **Settled on 40/1000ms**: a
~5x improvement over the original default, comfortable headroom against the GitHub
Actions 20-minute budget, without chasing marginal gains past the point that
mattered. Still overridable via `--batch-size`/`--pause-ms` if this ever needs
re-checking (e.g. if Attio's actual limits become visible at a much higher setting,
or if a future combined run alongside other passes changes the load picture).

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
