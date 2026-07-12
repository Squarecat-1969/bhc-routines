# bhc-routines

Canonical source for the **scheduled Claude Code Routines** behind Bobby Hougham's Relationship Operating System (Aida / BHC CRM).

These routines run **in the cloud, unattended, on their own cadence** — they are *not* part of the BHC-Aida web app's runtime and deliberately live in a separate repo (per Aida's `AGENTS.md`: routines must never sit in the tree Vercel builds/deploys on push).

## How this repo is used

- Each routine is a single self-contained prompt in `routines/<name>.md`.
- **To deploy a change:** edit the `.md` here → paste its full contents into that routine's cloud config (the routine UI). The repo is the source of truth; the routine UI is the execution surface.
- A secondary human-readable mirror also exists in the **"Claude Code Routines" Google Doc** (one tab per routine). Keep the Doc tab in sync when you change a file here.
- Routines write to the Google CRM (via the Aida `/api/brain/sheets` proxy) and to Attio (via the Attio MCP connector). They are the only writers to those live systems on their cadence — a repo/build session must never trigger one.

## Routines in this repo

| Routine | File | Cadence | Primary writes |
|---|---|---|---|
| Late Edition | [`routines/BHC_Late_Edition.md`](routines/BHC_Late_Edition.md) | Nightly (~11pm Lisbon) | `Brain_Complete`, `Reconciliation_Queue`, `Daily_Brief`, Attio cadence fields (PASS 4), `Pipeline_Cache` + `Name_Conflicts` (PASS 4.5) |
| Reconciler | [`routines/BHC_Reconciler.md`](routines/BHC_Reconciler.md) | Periodic / on-demand (read-only sweep) | `Reconciler_Report`, `Name_Conflicts` (enqueue only) |
| Reconciler Fix | [`routines/BHC_Reconciler_Fix.md`](routines/BHC_Reconciler_Fix.md) | On-demand, after a Reconciler run | Master_ID (A/C/E/F), Attio (`bhc_contact_id` + `job_title`/`company_name`/`email_addresses`), `Reconciler_Report` status |

> Cadence for the two Reconcilers is set in their cloud routine config — verify there before relying on the values above.

## Not yet migrated

These routines currently live only in the "Claude Code Routines" Google Doc and should be imported here for completeness in a later pass: **BHC_HF_Segment_Sync, BHC_HF_Import, BHC Enricher, BHC Zoom, BHC Part D — resolve handler.**

## Conventions

- One `.md` per routine at `routines/`. Move to a folder-per-routine only if a routine grows companion assets (fixtures, sub-prompts).
- Every change gets a dated line in [`CHANGELOG.md`](CHANGELOG.md).
- Guardrails that matter (identity cross-checks, name-verification gates, ARRAYFORMULA/HF_ protected columns, one-writer-to-Sheets) are encoded inline in each routine's Non-negotiables section — read them before editing.
