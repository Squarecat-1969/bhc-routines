# Zoom DISCOVERY — notes

Design and implementation notes for the DISCOVERY pass of the Zoom meeting-capture
pipeline. DISCOVERY polls the meeting-recording provider, appends new meetings to the
`Zoom_Staging` sheet tab as `NEW`, and backfills missing summary lines. Everything
downstream — STEP 0, PASS 1, PASS 2 — is unchanged and still lives in
`routines/BHC_Zoom.md`.

---

## 1. The defect this fixes

`routines/BHC_Zoom.md`, D-STEP 3, verbatim:

| Col | Value |
|---|---|
| E (participants) | comma-joined invitee names/emails |
| **G (topline_summary)** | **blank — PASS 2 fills this** |

**This is not a bug. The routine is specified to leave that column blank.**

`topline_summary` is a PASS 2 output. PASS 2 only runs *after* a row has been triaged
from `NEW` to `PROCESS`. So at the moment a human is asked to decide Process or Pass,
the column that decision depends on is empty **by design**.

The symptom: a triage queue full of rows titled "Impromptu Zoom Meeting" with no
participants and no summary, indistinguishable from each other, so nothing moves and
the queue grows.

This had been "fixed" twice before — once as a direct `topline_summary` defect and once
in a later PR. Both were real defects. Both were correctly fixed. **Both were in the
enrichment pass, which runs after the decision they were meant to inform.**

D-STEP 2 also never requested a summary from the provider, so the data was not merely
unwritten — it was never fetched.

### The general principle
**Capture must supply what triage needs.** If a human is asked to make a decision about
a captured item, the fields that decision depends on must be populated *at capture
time*, not by a later pass that only runs after the decision. A triage surface asking
for a judgement based on a column the pipeline has not yet filled is broken by design,
however correct each individual pass is.

---

## 2. What this is not

This is **not enrichment**. Enrichment means going out and finding context that is not
already in hand — reading a transcript, searching the web, composing a narrative
summary. That is PASS 2's job and it is untouched.

DISCOVERY writes a value the provider has **already computed** and hands back in a
response we are **already receiving**, which the pipeline currently discards. That is
transcription.

**Deliberate overlap, not duplication:** PASS 2 overwrites `topline_summary` when it
runs. That is correct. The DISCOVERY value has one job — make the row triageable — and a
deliberately short life.

---

## 3. Provider API facts

Verified against the provider's REST documentation and live responses, 2026-08.

**Auth:** `X-Api-Key: <key>` header. Base `https://api.fathom.ai/external/v1`.

**Rate limits:**
- Global: 60 requests / 60s
- **Heavy: 30 / 60s, and may be reduced to 5 / 60s under elevated load.** Heavy means
  the summary and transcript endpoints, **and `/meetings` with `include_summary=true`.**
- 429 responses carry `Retry-After`. **Honouring it is mandatory.** Check whether
  `src/lib/http.ts` already implements this before writing a second copy.

**`/meetings` returns per meeting:** `title`, `meeting_title`, `url`, `share_url`,
`created_at`, `scheduled_start_time`, `scheduled_end_time`, `recording_start_time`,
`recording_end_time`, `meeting_type`, `transcript_language`, `calendar_invitees`,
`recorded_by`, and optionally `transcript`, `default_summary`, `action_items`,
`crm_matches`.

**Summary shape** — four sections, provider-generated: Meeting Purpose · Key Takeaways ·
Topics · Next Steps. Returned as `{"summary": {"markdown_formatted": "..."}}`.

⚠ **Escaping differs by call shape.** The list endpoint returns escaped hashes
(`\#\#`); the per-recording endpoint returns clean markdown with the purpose wrapped in
a link. **Parse defensively for both.**

**Webhooks:** `POST /webhooks` with `destination_url`, `triggered_for`, and at least one
`include_*` flag. Fires on *new meeting content ready* — after processing completes —
and can carry the summary in the payload. Response returns `id`, `url`, `secret`
(`whsec_` prefixed).

**HMAC verification:** headers `webhook-id`, `webhook-timestamp`, `webhook-signature`.
Sign `${id}.${timestamp}.${rawBody}` with HMAC-SHA256 over the base64-decoded secret,
base64 the result, constant-time compare, reject timestamps outside ±300s.

---

## 4. Two behavioural facts that constrain the design

### 4.1 `calendar_invitees` is empty for every impromptu meeting, and this is causal
A meeting is titled "Impromptu" precisely *because no calendar invite exists*.
`calendar_invitees` derives from that invite. The field is empty for the same reason the
title is generic. Verified across four consecutive impromptu meetings.

### 4.2 ⚠ IMPROMPTU DOES NOT MEAN INTERNAL
A meeting titled "Impromptu Zoom Meeting" in live data turned out to be an external
client call. Any rule of the form *"no invitees, therefore internal, therefore
auto-pass"* would silently discard real client conversations.

**Do not build an internal/external classifier here.** There is no reliable signal at
capture time — the only authoritative attendee data is in the transcript, which is a
large per-meeting fetch. Attempting the inference recreates the exact fault being
fixed: a machine judgement made on data insufficient to support it.

Triage exists because a human decides. The pipeline's job is to supply enough to decide
in one glance, not to pre-decide badly. **Every row reaches the human.**

---

## 5. Field mapping

One row per new meeting appended to `Zoom_Staging`, columns A–N. Identical for both the
sweep and the webhook path. Unchanged from D-STEP 3 except **E** and **G**.

| Col | Value |
|---|---|
| A | `recording_id` |
| B | `title` (or `meeting_title`) |
| C | `recording_start_time` → `YYYY-MM-DD` |
| D | duration, or blank |
| E | **fallback ladder, §5.2** |
| F | `url` |
| G | **Meeting Purpose line, ≤200 chars, word-boundary trim** |
| H | `NEW` |
| I–M | blank |
| N | `RUN_ID` — `"ZOOM-DISC-" + unix ms` (sweep) or `"ZOOM-HOOK-" + unix ms` (webhook) |

### 5.1 Column G — topline
Take the text after the Meeting Purpose heading, up to the next heading (escaped or
not). Strip markdown link syntax — keep the label, discard the URL. Single line, capped
at 200 characters on a word boundary.

**If absent or unparseable, write blank. Never invent a topline.** A later sweep fills
it (§6.2).

### 5.2 Column E — participants, fallback ladder
**A fallback, not a replacement.** Real invitee data always wins.

- **Tier 1 — `calendar_invitees` present** → comma-join. No extra call.
- **Tier 2 — empty** → extract Next-Steps owners from the summary:
  ```
  /^\s*-\s*\[?\*\*([A-Z][\w'’\-]+)\*\*:/
  ```
  Bolded name, colon, at bullet start. Deduplicate, preserve order of appearance. Write
  with a mandatory provenance suffix: `Alex, Sam (from summary)`.
- **Tier 3 — neither** → blank. The topline alone still makes the row triageable.
  **Never guess.**

⚠ **THE `(from summary)` SUFFIX IS LOAD-BEARING.** It marks a derived list so nothing
downstream mistakes it for verified attendees. PASS 2 resolves real participants from
the transcript; this is a triage hint only.

**Verified safe within this repo:** nothing parses column E as structured data. P2-STEP 1
reads A–N but captures only `recording_url`, `recording_id`, `title`, `meeting_date` and
`review_notes`; P2-STEP 4 re-derives participants from the provider directly.
**Not verified in the Aida app** — confirm `/api/zoom/staging` and the Meetings component
treat column E as display-only before shipping.

### 5.3 Explicitly rejected
Scanning the whole summary for capitalised words. These summaries are dense with product
and vendor names, which would land in a participants field. **Next-Steps owners only.**

### 5.4 Accepted limit
The regex only catches people **assigned an action item**. Someone who attended and
committed to nothing will not appear, and the field stays blank — no worse than today,
and never wrong. **Silence is the correct failure mode here.**

---

## 6. Phase A — the scheduled sweep

Built first. It fixes the existing backlog, which no webhook can, and it is the safety
net that makes a missed event survivable.

### 6.1 Files
```
src/lib/fathom.ts               REST client. Mirror src/lib/attio.ts. Use lib/http.ts.
src/passes/zoom-discovery.ts    Pass logic. Pure functions where possible.
src/cli/run-zoom-discovery.ts   --dry-run / --live / --json-out / --limit
tests/zoom-discovery.test.ts    vitest
.github/workflows/zoom-discovery.yml
```

`package.json` scripts, matching existing naming:
```json
"zoom-discovery": "tsx src/cli/run-zoom-discovery.ts",
"zoom-discovery:dry": "tsx src/cli/run-zoom-discovery.ts --dry-run",
"zoom-discovery:live": "tsx src/cli/run-zoom-discovery.ts --live"
```

**No SDK.** Raw REST through `lib/http.ts`, matching this repo's zero-dependency
convention (`dotenv` and `zod` only).

**Unit-test the parsers against real fixtures:** Meeting Purpose extraction, the
Next-Steps regex, the 200-char word-boundary trim, and **both escaping variants**. These
are pure string functions.

### 6.2 Two jobs, one pass

**Discover** — 24-hour lookback. Deduplicate against existing rows on `recording_id`
**and** `url`.
⚠ Two URL formats exist in live data (`/share/<token>` and `/calls/<id>`), so a naive
URL join fails on every meeting. **Prefer `recording_id`.**

**Backfill blank toplines** — same run, **same extraction functions, not a separate
script.** A second implementation drifts, and then the queue and new captures disagree.
- Scope: rows with `status` = `NEW` and column G blank. **Check the live sheet for other
  pre-triage statuses rather than assuming the lifecycle from spec text.**
- **Fill blanks only. Never overwrite a non-empty column E or G.** A populated value may
  be PASS 2's and is strictly better.
- **Cap at 10 rows per run** — heavy-request limits degrade to 5/60s under load.

This makes the one-off backfill a permanent self-healing feature: a meeting still being
processed by the provider gets its row now and its topline on a later sweep.

### 6.3 Workflow
```yaml
on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:
    inputs:
      mode: { default: 'live', type: choice, options: [live, dry-run] }
```

**No DST cron pair.** Late Edition needed two expressions to hit a specific local hour,
which produced a real double-run bug. A 30-minute sweep has no target time, so seasonal
drift is meaningless. Single expression, as in `reconciler.yml`.

**GitHub cron delay is irrelevant here.** `late-edition.yml` documents runs firing 2.5–4
hours late. On a read-only 30-minute sweep a late fire simply picks up everything since.
There is no correctness dependency on *when* it runs — which is what made cron fatal for
Late Edition and harmless for this.

⚠ **DEFAULT TO `live` AND BRANCH ON `event_name`.** `late-edition.yml` documents the
trap: with `--live` coming solely from `inputs.mode`, a dropped input silently falls back
to dry-run and the workflow runs green while writing nothing. Follow `reconciler.yml`:
```bash
if [ "${{ github.event_name }}" = "workflow_dispatch" ] && [ "${{ inputs.mode }}" = "dry-run" ]; then
  npm run zoom-discovery -- --dry-run --json-out out/zoom-discovery-report.json
else
  npm run zoom-discovery -- --live --json-out out/zoom-discovery-report.json
fi
```

Also: `concurrency: { group: zoom-discovery, cancel-in-progress: false }` ·
`timeout-minutes: 10` · typecheck and test before the run · artifact upload with 7-day
retention.

**Slack:** post to the routines channel **only when rows were added or toplines
backfilled.** A sweep announcing "nothing found" 48 times a day is worse than silence.

**Note:** scheduled workflows are disabled after 60 days of repository inactivity — a
silent-stop mode worth knowing about.

### 6.4 Secret
`FATHOM_API_KEY` as a repository Actions secret, and locally in `.env` (gitignored).
**Record it in the credential inventory at the same time** — this system's credentials
already live in six mutually-invisible homes, and an untracked seventh is how the last
full credential rebuild became necessary.

---

## 7. Phase B — the webhook

Built after the sweep has run clean. Because the sweep is already running, **a missed
webhook costs nothing** — which is the entire reason for this order.

### 7.1 Configuration
```json
POST https://api.fathom.ai/external/v1/webhooks
{
  "destination_url": "https://<app-host>/api/zoom/fathom-hook",
  "triggered_for": ["my_recordings"],
  "include_summary": true,
  "include_action_items": true,
  "include_crm_matches": true,
  "include_transcript": false
}
```

**`triggered_for: ["my_recordings"]` only.** The recorder must have been actively present
for a meeting to belong in this pipeline — and if it was, the recording is ours
regardless of whose platform hosted the call (live data contains Teams meetings captured
this way). Recordings shared in by others, where our recorder was not present, are
handled by manual paste into the Conversations surface. The other scopes pull in
colleagues' calls we were not on — scope a CRM capture pipeline should not have.

**`include_transcript: false`**, for three reasons:
1. `routines/BHC_Zoom.md` P2-STEP 3 states it plainly: the transcript is *"for reasoning
   only; **never store it**."*
2. **A Google Sheets cell caps at 50,000 characters.** An hour-long transcript routinely
   exceeds that and would truncate **silently** — appearing stored while being
   incomplete.
3. It saves nothing real. PASS 2 fetches the transcript when it runs, possibly days
   later; capturing it early only parks sensitive verbatim content in a staging tab in
   the meantime.

**`include_action_items` and `include_crm_matches` are worth capturing** — both small and
structured. Action items are a head start on PASS 2's task extraction; `crm_matches` is
the provider's own participant resolution, a free cross-check against the identity
lookup. Neither is written to `Zoom_Staging` in this build; capture them for a later
pass rather than expanding the schema now.

⚠ **Enabling these flags creates a standing outbound feed** of every future matching
recording, running until the webhook is deleted. Meeting content can be commercially and
legally sensitive. This is a deliberate decision, not a configuration toggle, and is
acceptable only because the destination is our own application.

### 7.2 The route
`app/api/zoom/fathom-hook/route.ts` in the Aida app.

1. Read the **raw body before any JSON parsing** — the HMAC is computed over the raw
   string.
2. Verify per §3: reconstruct `${webhook-id}.${webhook-timestamp}.${rawBody}`,
   HMAC-SHA256 with the base64-decoded secret, base64 the digest, constant-time compare
   against each signature in `webhook-signature` (stripping `v1,` prefixes), and reject
   timestamps outside ±300s.
3. **Reject with 401 on failure. Never process an unverified payload.**
4. Extract fields per §5 — the payload already carries the summary, so **no provider call
   and no heavy request**.
5. Deduplicate on `recording_id` against `Zoom_Staging`.
6. Append through the existing Sheets proxy.
7. Return 200 promptly; do the work asynchronously if the platform allows.

**No CI dispatch, no PAT.** The route writes directly, which removes a credential
entirely.

⚠ **This is a new public endpoint on an app that has previously shipped unauthenticated
API routes.** HMAC verification must be in the first commit, and the auth middleware
needs a deliberate, commented exclusion — the same explicit treatment the sheets proxy
route has, for the same reason. **Return 401 JSON, never a 307 redirect to a login page**
— redirecting a machine caller turns a clean auth failure into a downstream parse error.

### 7.3 Secret
`FATHOM_WEBHOOK_SECRET` in the app's environment (the `whsec_` value from the create
response). Record it in the credential inventory.

### 7.4 Once proven
Drop the sweep to **3–4× daily** as a safety net — the same pattern `reconciler.yml` uses
in keeping an independent weekly slot so a silently broken trigger chain is still caught
within the week.

---

## 8. Changes to `routines/BHC_Zoom.md`

Delete **D-STEP 1, 2 and 3**. Replace with a pointer stating that DISCOVERY now runs as a
TypeScript routine on its own schedule plus a provider webhook, and that PASS 1 and
PASS 2 are unchanged. Update non-negotiables #1 and #3 accordingly.

**Change nothing else in that file.**

---

## 9. Acceptance

- Every newly discovered row has a non-empty `topline_summary`, or blank with a logged
  reason.
- Rows with real invitees keep them unchanged, with no suffix.
- Every derived participant list carries `(from summary)`.
- Zero rows where a populated field was overwritten.
- No duplicate rows — verified with an overlapping-lookback run.
- Dry-run writes nothing, verified by character count before and after.
- A previously unidentifiable row is triageable at a glance on the live Meetings surface.
- The Slack channel stays silent on a no-op run.
- **Phase B:** an unsigned POST to the hook returns 401 and writes nothing.

---

## 10. Do not

- Touch PASS 1, PASS 2 or STEP 0.
- Add columns to `Zoom_Staging`.
- Auto-pass, auto-classify, or infer internal versus external.
- Write to any CRM. Both paths are read-only apart from appending to a staging tab.
- Build a second backfill implementation.
- Store transcripts.
