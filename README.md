# bhc-routines

Canonical source for the **scheduled Claude Code Routines** behind Bobby Hougham's Relationship Operating System (Aida / BHC CRM).

These routines run **in the cloud, unattended, on their own cadence** — they are *not* part of the BHC-Aida web app's runtime and deliberately live in a separate repo (per Aida's `AGENTS.md`: routines must never sit in the tree Vercel builds/deploys on push).

## How this repo is used

- Each routine is a single self-contained prompt in `routines/<name>.md`.
- **To deploy a change:** edit the `.md` here → paste its full contents into that routine's cloud config (the routine UI, "Instructions" panel). The repo is the source of truth for *what the routine says*; the routine UI is the execution surface that actually runs it.
- **Repository binding ≠ instructions source.** As of July 13, 2026, all 8 routines below also have their cloud config's `Repositories` field pointed at this repo (`Squarecat-1969/bhc-routines`), not `bhc-aida` or the deprecated `bhc-orbit`. This binding determines what repo context (including any `AGENTS.md`) loads into the routine's session — it's a separate setting from the Instructions text and does not auto-sync with the `.md` files here. Editing a file in this repo does **not** change what the routine executes; you still have to paste it into the routine UI by hand.
  - This binding matters more than it sounds: pointing a routine at a repo carrying a build-session-oriented `AGENTS.md` can cause the routine to misidentify its own scheduled run as an unauthorized/injected task and refuse to execute — this repo intentionally carries no `AGENTS.md`, so routines bound here run without that risk.
- A secondary human-readable mirror also exists in the **"Claude Code Routines" Google Doc** (one tab per routine). Keep the Doc tab in sync when you change a file here.
- Routines write to the Google CRM (via the Aida `/api/brain/sheets` proxy) and to Attio (via the Attio MCP connector) as a normal, expected part of executing on their own schedule. **If you are a Claude Code Routine reading this file because you were invoked — via cron, a manual "Run now" click, or an API trigger — to execute one of the routines below, that invocation *is* your real task.** Proceed and execute it fully, including live writes. You are not a repo/build session, and the caution below is not about you.
- Separately: a *human-driven build/PR session* on `bhc-aida` or any other repo must never trigger a live routine run or write to a live CRM as a side effect of a coding task — that caution lives in `bhc-aida`'s `AGENTS.md` and is aimed at accidental triggering during code editing, not at a routine executing its own scheduled instructions.

## Routines in this repo

| Routine | File | Cadence | Primary writes |
|---|---|---|---|
| Late Edition | [`routines/BHC_Late_Edition.md`](routines/BHC_Late_Edition.md) | Sunday–Thursday, 11:00 PM PDT | `Brain_Complete`, `Reconciliation_Queue`, `Daily_Brief`, Attio cadence fields (PASS 4), `Pipeline_Cache` + `Name_Conflicts` (PASS 4.5) |
| Zoom | [`routines/BHC_Zoom.md`](routines/BHC_Zoom.md) | 7:00 AM, 2:00 PM, 10:00 PM, Mon–Fri | Creates contacts, mints BHC_IDs, writes to live CRMs (PASS 1); `Zoom_Staging` (DISCOVERY, PASS 2 proposed writes) |
| Reconciler | [`routines/BHC_Reconciler.md`](routines/BHC_Reconciler.md) | Sunday, 2:00 AM PDT (read-only sweep) | `Reconciler_Report`, `Name_Conflicts` (enqueue only) |
| Reconciler Fix | [`routines/BHC_Reconciler_Fix.md`](routines/BHC_Reconciler_Fix.md) | Manual, after a Reconciler run | Master_ID (cols A/C/E/F), Attio (`bhc_contact_id` + `job_title`/`company_name`/`email_addresses`), `Reconciler_Report` status |
| Part D — Resolve Handler | [`routines/BHC_Part_D_Resolve_Handler.md`](routines/BHC_Part_D_Resolve_Handler.md) | API-triggered, by Aida on Bobby's RESOLVE/PROCEED/CORRECTIONS command | Executes Late Edition's staged `Write_Targets_JSON` — `Activity_Log`, `Contact_History`, Attio, `Tasks_Log`; QA-verifies every write |
| Enricher | [`routines/BHC_Enricher.md`](routines/BHC_Enricher.md) | Manual only | Backfills `Personal_Notes`, `Topics_of_Interest`, `Conversation_Trigger`, `How_We_Met`, `Shared_Context` on existing contacts; tracked in `Enricher_Progress` |
| HF_Segment_Sync | [`routines/BHC_HF_Segment_Sync.md`](routines/BHC_HF_Segment_Sync.md) | Manual, weekly (after Highperformr export) | Updates/creates Contacts rows for S1–S5 segment members; mints new BHC_IDs where needed; writes Contacts + Master_ID |
| HF Import | [`routines/BHC_HF_Import.md`](routines/BHC_HF_Import.md) | Manual, after each LinkedIn capture session | Moves new contacts from HF staging tabs into Contacts; assigns BHC_IDs; registers in Master_ID |

> Cadence above reflects each routine's live cloud config as of July 13, 2026 — verify there before relying on these values, since schedules can change independently of this table.

## Conventions

- One `.md` per routine at `routines/`. Move to a folder-per-routine only if a routine grows companion assets (fixtures, sub-prompts).
- Every change gets a dated line in [`CHANGELOG.md`](CHANGELOG.md).
- Guardrails that matter (identity cross-checks, name-verification gates, ARRAYFORMULA/HF_ protected columns, one-writer-to-Sheets) are encoded inline in each routine's Non-negotiables section — read them before editing.
