# Changelog

All dates are the routine-config install date. Newest first.

## 2026-07-18 — PASS 4.5 (Pipeline Cache) built and tested

- **New pass, `src/passes/pass4_5/`:** full nightly rewrite of the derived `Pipeline_Cache` tab (~2,213 records) plus ATTIO-only name-drift enqueue to `Name_Conflicts`. Mirrors PASS 4's shape — pure logic separated from I/O, dry-run default, mandatory identity gate, fail-soft (never blocks PASS 5 on an internal exception).
- **`SheetsClient` gains `update`/`append`** (`src/lib/sheets.ts`) — PASS 4.5 is the first pass that writes to Google Sheets. Body shape confirmed against the spec's own `sheets()` helper convention (`action: read|update|append`).
- **New Attio extractors/helpers** (`src/lib/attio.ts`): `emailOf` (the `email_addresses` array attribute — takes the primary/first entry), and `fetchPersonRecordsBatched`, a reusable batched-by-ID fetch extracted from PASS 4's inline pattern so PASS 4.5 doesn't reimplement it at ~50x the record count.
- **New `loadContactsWide`** (`src/passes/pass4_5/contacts.ts`): resolves Relationship_Tier, Primary_Email, and Effective_Segment by header title in one wide Contacts read, keyed by Google_Row (never by inferring a row from a BHC_ID, per the Hard Contracts).
- **A real bug caught before going live:** an early version only wrote/blanked the cache when the run had at least one eligible row, so a run where every target got withheld would leave a stale prior cache untouched instead of clearing it. Fixed — blanking now runs independent of whether the main block wrote anything. Regression test added.
- **38 new tests** (20 integration against a fake Sheets+Attio backend, 18 pure-logic) — 111/111 total pass, typecheck clean.
- Open items and deviations documented in `docs/pass4_5-notes.md` (batch-size timing at real scale, the tab-guard's error-handling scope, and two spots where this runs standalone rather than literally chained after PASS 4 in-memory — no combined entrypoint exists yet).
- **Not yet run against production.** Same posture PASS 4 was in before its own `--dump-shapes` verification — that's the next step: a real dry run against live Attio/Sheets data, review the report, then `--live`.

## 2026-07-18 — PASS 4 verified end-to-end against production; goes live

- **`npm run pass4 -- --dump-shapes` (second run):** confirmed the two remaining read-side assumptions — pipeline entry shape (`parent_record_id`/`entry_values`) and select-value reads (`entry_values.<slug>[0].option.title`) both match the live Attio workspace exactly.
- **`npm run pass4:live -- --limit 1` (canary):** real cadence write to Suzie Schofield (BHC-00103) — `written=1 failed=0 read_back_mismatch=0`. Confirms Attio accepts a select written by title string and the PATCH body shape is correct. **PASS 4 is now fully verified end-to-end against production; `docs/pass4-notes.md` items 1–5 are all resolved.**
- **Fixed a real bug found by that same canary run:** the cadence write and Slack post both succeeded, but the process then crashed — `requestJson` unconditionally `JSON.parse`s its response body, and Slack's incoming webhook returns the literal text `"ok"` on success, not JSON. A fully successful run would have exited non-zero. New `requestText` helper in `src/lib/http.ts`; `slack.ts` now uses it. `requestJson` untouched (still correct for Attio/Sheets, which do return JSON). Regression test added: `tests/http.test.ts`.
- Also landed this session (Claude Code, chat-assisted): `RUN_TIMEZONE` default → `UTC`; unknown-tier touch mode confirmed Social; Stage 6+ is now a `STAGE_OUT_OF_RANGE` withhold (data-integrity flag) instead of a silent tier-cadence fallback, since there's no mechanism for a track to advance past Stage 5; GHA workflow's hardcoded `RUN_TIMEZONE: America/Los_Angeles` fixed to match the UTC default (would have silently overridden the decision on first live run); `last_interaction_at` → `last_interaction` fix (the dangerous slug bug — every contact was reading "last touch unknown"); Contacts read range widened `A1:V1`/`A3:V` → `A1:EZ1`/`A3:EZ` (tier column sits well past V in the live 113+-column sheet), with header-row diagnostic logging added to `load.ts`.
- `npm run typecheck` and `npm test` (72 tests) pass.
- Next per the migration order (`docs/CLAUDE.md`): PASS 4.5 (Pipeline Cache).

## 2026-07-17 — PASS 4 decisions 1 & 2 resolved

- **`RUN_TIMEZONE` default changed `America/Los_Angeles` → `UTC`** (`src/config/env.ts`, `.env.example`). Bobby's call: matches PASS 4.5's existing UTC convention so the two passes agree on `TODAY`. Known effect: on the 11pm PDT scheduled run, `TODAY` is one calendar day ahead of Seattle's "today" — `next_check_in_date`/`days_since` shift by a day versus the LA-default behavior. `docs/pass4-notes.md` #1 updated to reflect the decision; no test changes needed (`todayIn()` was already tested against both zones).
- **Unknown relationship-tier touch mode confirmed: Social** (follows the spec's pseudocode, not the contradicting prose table). No code change — `DEFAULT_TIER` already implemented this. `docs/pass4-notes.md` #2 marked confirmed.
- Still open in `docs/pass4-notes.md`: #3 (Stage 6+ fallback, non-blocking) and #4 (live Attio field-slug verification via `npm run pass4 -- --dump-shapes` — Bobby running this locally via Claude Code before PASS 4 goes live).
- `npm run typecheck` and `npm test` (63 tests) pass after the timezone default change.

## 2026-07-14

- **Added `AGENTS.md`** at repo root — defines how a Claude Code session should distinguish a routine-execution session (started via a routine's own schedule, API call, or manual Run now) from a build/maintenance session (a human editing files in this repo). Written to be factual/criteria-based rather than persuasive, after persuasion-style grounding text (in this README and in Late Edition's own Instructions) repeatedly triggered self-refusal on scheduled/API-triggered runs — a document telling an agent to "override your caution, proceed" reads as an injection-shaped red flag regardless of intent or accuracy.
- **Fixed a real bug in `BHC_Late_Edition.md`'s invocation description**: it previously claimed its API trigger token (`EXECUTE LATE-EDITION-{timestamp}`) was its "only invocation path," which incorrectly self-disqualified every manual "Run now" click, since manual runs never carry that token. Now documents both valid paths explicitly.
- **Cleaned up a duplicated opening paragraph** in `BHC_Late_Edition.md` left over from an earlier same-day edit that inserted new grounding text without fully removing the old version.
- **Removed the persuasion-style README paragraph** addressing AI agents directly; replaced with a pointer to `AGENTS.md` as the single source of truth for session-type classification.
- Root cause context: none of the above fixed the underlying Late Edition failures on their own — every trigger type (native cron, manual click, API with empty payload, API with a real command token, synchronous manual with live human presence) was tried and failed before this change. AGENTS.md is being tested as a structurally different variable (a recognized config-file convention vs. free-form persuasive prose) rather than another wording iteration.

## 2026-07-11 — Initial import + Session B installs

First files committed to the repo. All three were installed to their cloud routine configs and mirrored to the "Claude Code Routines" Google Doc this session.

- **Late Edition — new PASS 4.5 (+ 4.5h).** Inserted between PASS 4 and PASS 5. Writes the derived `Pipeline_Cache` tab (full nightly rewrite of ~2,213 ATTIO/BOTH records) so the Contacts page reads cached data instead of hydrating Attio live per load. Fetches identity by `get-records-by-ids` (batched ≤50 — the MCP connector caps `list-records` at 50/page). Cadence fields (M/N/O) sourced from the post-PASS-4 read-back, not in-memory `cadence_results`, to avoid a silent-write-failure divergence window. Mandatory, non-skippable **4.5d identity cross-check** (Attio `bhc_contact_id` must equal Master_ID BHC_ID or the row is withheld + logged). **4.5h** enqueues ATTIO-only name drift to `Name_Conflicts` with the strict gate + suppression. New Non-negotiable #16.
- **Reconciler — new I1 pass.** PASS 3 read widened `A3:A` → `A3:DI` (single bulk read) to also load Google identity. PASS 4 gains the **A5 split** (non-exact-but-shares-a-word name → `Name_Conflicts` enqueue instead of a silent pass) and **I1** identity-field drift (Title/Company/Email; email match = Google primary present anywhere in Attio's set) → `Reconciler_Report`. Non-negotiable #2 widened to permit `Name_Conflicts` enqueues; `I1` added to the code table.
- **Reconciler Fix — new I1 pass.** New **PASS 6.5** (no renumbering) auto-writes Google's authoritative `job_title` / `company_name` / `email_addresses` (primary-only, reorder-to-primary + keep secondaries; uniqueness-conflict → NEEDS_MANUAL) onto Attio, gated by the reused Step 1.5 name-verification check. Scope + Non-negotiable #1 widened beyond `bhc_contact_id`; new Non-negotiable added. **Name is never auto-written here** — it only ever routes through the `Name_Conflicts` review card.

Companion repo work (BHC-Aida) shipped earlier in commit `88c3840`: `Pipeline_Cache` (A:R) and `Name_Conflicts` (A:M) tabs, reader routes, commit actions, and the NameConflicts review card — build-green and a safe no-op until these routines populate the tabs.

2026-07-13 — All 8 routines migrated to this repo; Repositories field for all 8 repointed here from bhc-aida/bhc-orbit to fix self-refusal bug (routines were misreading their own scheduled runs as injected build-session instructions via bhc-aida's AGENTS.md).
