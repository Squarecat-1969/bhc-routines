# Changelog

All dates are the routine-config install date. Newest first.

## 2026-07-11 — Initial import + Session B installs

First files committed to the repo. All three were installed to their cloud routine configs and mirrored to the "Claude Code Routines" Google Doc this session.

- **Late Edition — new PASS 4.5 (+ 4.5h).** Inserted between PASS 4 and PASS 5. Writes the derived `Pipeline_Cache` tab (full nightly rewrite of ~2,213 ATTIO/BOTH records) so the Contacts page reads cached data instead of hydrating Attio live per load. Fetches identity by `get-records-by-ids` (batched ≤50 — the MCP connector caps `list-records` at 50/page). Cadence fields (M/N/O) sourced from the post-PASS-4 read-back, not in-memory `cadence_results`, to avoid a silent-write-failure divergence window. Mandatory, non-skippable **4.5d identity cross-check** (Attio `bhc_contact_id` must equal Master_ID BHC_ID or the row is withheld + logged). **4.5h** enqueues ATTIO-only name drift to `Name_Conflicts` with the strict gate + suppression. New Non-negotiable #16.
- **Reconciler — new I1 pass.** PASS 3 read widened `A3:A` → `A3:DI` (single bulk read) to also load Google identity. PASS 4 gains the **A5 split** (non-exact-but-shares-a-word name → `Name_Conflicts` enqueue instead of a silent pass) and **I1** identity-field drift (Title/Company/Email; email match = Google primary present anywhere in Attio's set) → `Reconciler_Report`. Non-negotiable #2 widened to permit `Name_Conflicts` enqueues; `I1` added to the code table.
- **Reconciler Fix — new I1 pass.** New **PASS 6.5** (no renumbering) auto-writes Google's authoritative `job_title` / `company_name` / `email_addresses` (primary-only, reorder-to-primary + keep secondaries; uniqueness-conflict → NEEDS_MANUAL) onto Attio, gated by the reused Step 1.5 name-verification check. Scope + Non-negotiable #1 widened beyond `bhc_contact_id`; new Non-negotiable added. **Name is never auto-written here** — it only ever routes through the `Name_Conflicts` review card.

Companion repo work (BHC-Aida) shipped earlier in commit `88c3840`: `Pipeline_Cache` (A:R) and `Name_Conflicts` (A:M) tabs, reader routes, commit actions, and the NameConflicts review card — build-green and a safe no-op until these routines populate the tabs.
