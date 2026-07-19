# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

[`AGENTS.md`](AGENTS.md) is the single source of truth for distinguishing a **routine-execution session** (started by a routine's own schedule, API trigger, or "Run now") from a **build/maintenance session** (a human in the conversation asking you to edit, review, or discuss). Read it before assuming which you are. Do not restate or re-derive its logic here or in routine files.

## Two layers, mid-migration

This repo is being rebuilt from prompt specs into deterministic code. Both layers coexist; know which one you're touching.

**`routines/*.md` — the prompt specs.** Markdown, no toolchain. The Python inside them is *instructions for a future LLM session to execute at runtime* — never run from this repo, not importable. Don't execute a routine's Python to "check" it. The only verification is reading: does the stated write shape match its Non-negotiables, and do its ranges match the tabs in its own preamble?

**`src/` — the TypeScript rebuild.** Real code, real tests. Ported pass by pass, lowest-risk first; each pass is verified against read-only production data before its writes are switched on.

```bash
npm ci
npm run typecheck
npm test              # vitest; single file: npx vitest run tests/cadence.test.ts
npm run pass4:dry     # compute + print, writes nothing
npm run pass4:live    # writes cadence to Attio
npm run pass4 -- --dump-shapes   # print raw Attio payloads to verify slugs
npm run pass4_5:dry   # compute + print, writes nothing
npm run pass4_5:live  # writes Pipeline_Cache + enqueues Name_Conflicts
npm run pass1:dry     # compute + print, writes nothing
npm run pass1:live    # deletes resolved Brain_Complete rows, compacts survivors
npm run pass0:dry     # compute + print, writes nothing
npm run pass0:live    # closes exact-match placeholders, enqueues inferred matches
npm run pass2:dry     # writes nothing to Sheets, but DOES call the real Anthropic API
npm run pass2:live    # writes Brain_Complete rows, marks Thread_Staging PROCESSED
npm run pass2_5:dry   # writes nothing to Sheets, but DOES call the real Anthropic API
npm run pass2_5:live  # writes to Reconciliation_Queue (SUPERSEDE-IN-PLACE)
npm run pass3 -- --run-id LATE-EDITION-... --dry-run   # --run-id required — digests a specific prior run
npm run pass3 -- --run-id LATE-EDITION-... --live      # posts the digest to #aida
npm run pass5 -- --run-id LATE-EDITION-... --dry-run   # --run-id required — same reasoning as PASS 3
npm run pass5 -- --run-id LATE-EDITION-... --live      # writes Daily_Brief
npm run inspect:activity-log   # read-only — dumps real Activity_Log header/sample rows
```

Migration status: **The full Late Edition rebuild is complete, 2026-07-19 — all eight passes (0, 1, 2, 2.5, 3, 4, 4.5, 5) now have real, tested TypeScript implementations.** PASS 4, PASS 4.5, PASS 1, and PASS 0 are live-run confirmed against production. PASS 2 is fully built and live-verified — 31 real threads processed across dry/live runs, two real bugs found-fixed-reverified, one prompt-quality fix reverified clean on a harder batch. **PASS 2.5, PASS 3, and PASS 5 are built and tested (384/384 tests pass) but not yet run against production.** See `docs/pass2-notes.md`, `docs/pass2_5-notes.md`, `docs/pass3-notes.md`, `docs/pass5-notes.md` for each pass's real findings and resolved ambiguities. **What's left before this can run unattended**: live dry-runs for PASS 2.5/3/5 (same "run it, read the real output, fix what's wrong" discipline every other pass went through), and — the one piece nothing has built yet — a combined orchestrator chaining all eight passes with one shared `RUN_ID` and in-memory data passing between them, which the spec itself assumes for PASS 3/5's cross-pass data (drift alerts in particular currently can't be recovered standalone — see `docs/pass3-notes.md`). Right now each pass is independently runnable and tested but the passes have never been chained together for a real end-to-end nightly run.

Ground rules for the rebuild:
- **Dry-run is the default.** `--live` must be explicit. An integration test asserts dry-run issues zero mutating requests — keep it that way.
- **LLM calls stay narrow.** Single-purpose Anthropic API calls with a fixed JSON schema, one well-defined task each. Never agentic tool-use loops re-interpreting a whole pass.
- **The spec is the source of truth for behavior.** Where it's ambiguous, resolve it in `docs/pass4-notes.md`-style notes and flag it — don't quietly pick.
- Pure logic (cadence math, identity gates) is separated from I/O so it's testable without credentials; `tests/helpers/fake-backend.ts` fakes Attio + Sheets over real HTTP for the orchestration.

## Deploy model — the repo does not execute anything

Editing a `.md` here changes **nothing** about what runs in the cloud. To ship a change:

1. Edit `routines/<name>.md`.
2. Paste the file's **full contents** into that routine's cloud config → Instructions panel.
3. Mirror the change into the matching tab of the "Claude Code Routines" Google Doc.
4. Add a dated line to [`CHANGELOG.md`](CHANGELOG.md) (newest first; dates are the *routine-config install date*, not the commit date).

The routine config's `Repositories` field (pointed at `Squarecat-1969/bhc-routines` for all 8) controls what repo context loads into a routine's session. It is a separate setting from Instructions and does not sync with these files.

## Architecture

Eight independent routines, one shared substrate. There is no shared library — each `routines/<name>.md` is a **self-contained prompt** that redeclares its own constants, auth helper, and passes. Duplication across files is intentional; a change to a common helper must be applied file-by-file.

**Shared substrate every routine assumes:**

- **Google CRM** — one sheet (`GOOGLE_CRM_SHEET_ID = 1R_6tDw…`). All reads/writes go through the Aida proxy `https://aida.hougham.us/api/brain/sheets` with `BRAIN_API_TOKEN` (service-account key lives in Vercel). Same `sheets(action, range, values)` helper is pasted into each file.
- **Attio** — via the Attio MCP connector. `list-records` caps at 50/page; fetch by ID in batches with `get-records-by-ids`.
- **`Master_ID` tab is the identity registry.** `A BHC_ID · B Full_Name · C Location (GOOGLE/ATTIO/BOTH) · D Google_Row · E Attio_Record_ID · F Notes`. `Google_Row` is the *only* row authority — never infer a row from the BHC_ID number.
- **Slack `#aida`** — routines post as "Aida," the system's standing bot identity.

**Two write disciplines, and the line between them matters:**

- **Stage → resolve → execute.** Late Edition (PASS 0–3) reads threads and stages `Write_Targets_JSON` in `Brain_Complete`; it never touches live CRMs. Bobby resolves the digest; Aida then API-triggers **Part D**, which executes exactly what was staged and QA-verifies each write. Part D *executes, never re-derives* — if a fix belongs in the judgment, it belongs in Late Edition.
- **Direct live writes.** Zoom PASS 1 (creates contacts, mints BHC_IDs), Late Edition PASS 4 (Attio cadence fields only — mechanical, not judgment), Reconciler Fix, and both HF routines write live. Reconciler itself is read-only and enqueue-only.
- **Derived staging tabs** (`Pipeline_Cache`, `Daily_Brief`, `Name_Conflicts`, `Zoom_Staging`) are disposable — rewritable without Bobby's resolve, because nothing there is a permanent record.

**Cross-routine flow:** Zaps/Fathom capture → routines judge → staging tabs → Aida UI → Bobby resolves → Part D writes. "Zaps capture, you think" is the stated principle: never rebuild capture logic inside a routine.

## Editing routine files

Each file's **Non-negotiables** section is the load-bearing part. It encodes constraints learned from real breakage, not style preferences. Read it before touching that routine, and update it in the same edit if a change alters what's allowed.

Recurring ones worth knowing up front:

- **Never write ARRAYFORMULA or `HF_` columns**, and never write row 2 of `Contacts` (ARRAYFORMULA spill — data starts at row 3). Protected columns are listed per-routine (e.g. HF Import: U, AP–AR, BH–BJ, BU–BX, CH–CO, CQ).
- **Mint BHC_IDs serially** — read max → write Contacts → append Master_ID → increment. Never parallel-mint.
- **Never fabricate a BHC_ID or any looked-up value.** Unmatched → flag, don't guess.
- **Flat strings only** in `Brain_Complete` / `Write_Targets_JSON`. A participant-keyed object (`{"bobby": "…"}`) bypasses the TS string guard and crashes the Aida UI with React error #31.
- **Small explicit ranges on every write**; dropdown columns take exact allowed values only.
- **Name is never auto-written.** Name drift always routes through the `Name_Conflicts` review card. Identity cross-checks (Attio `bhc_contact_id` must equal the Master_ID BHC_ID) are mandatory and non-skippable.
- **Passes fail soft, per-contact.** One bad write never aborts a pass; a failed late pass never blocks an earlier one. Drift checks withhold a contact and warn — they don't abort the run.
- **Never propagate financial figures, medical/government PII, or credentials** into any extract.

The name-verification gate (Reconciler Fix Step 1.5 — lowercase, strip punctuation, ≥1 significant word in common, particles excluded) is the guardrail whose absence corrupted ~82 records in June 2026. In `src/` it lives once, in [name-verify.ts](src/lib/name-verify.ts). Reuse it; don't write a second one.

Numbered passes are load-bearing across files and configs — insert with a decimal (`PASS 4.5`, `PASS 6.5`) rather than renumbering.

## Conventions

- One `.md` per routine in `routines/`. Move to a folder-per-routine only if one grows companion assets.
- The README's cadence table reflects live cloud config as of a stated date — verify in the routine UI before relying on it; schedules change independently of this repo.