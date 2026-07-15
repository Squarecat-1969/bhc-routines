# Changelog

All dates are the routine-config install date. Newest first.

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
