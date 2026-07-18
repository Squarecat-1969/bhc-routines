# PASS 1 (built) & PASS 0 (built) — implementation notes

Companion to `src/passes/pass1/` and `src/passes/pass0/`. Mirrors
`docs/pass4-notes.md`/`docs/pass4_5-notes.md`'s format.

---

## PASS 1 — Housekeeping: built, tested, not yet run against production

The entire spec for this pass, verbatim: *"Read Brain_Complete!A:AD. Delete rows
where col V = TRUE (rewrite survivors back into A2:AD, clear trailing rows). Read
Thread_Staging!A:W. Working set = every row where col V ≠ PROCESSED."* Two
housekeeping steps, both against explicitly spec'd column layouts (unlike PASS 0
below) — genuinely no open questions.

**One inferred, not spec-mandated choice:** wrapped the whole pass in the same
fail-soft try/catch as PASS 4.5 (catch, log, report aborted, never re-raise). The
PASS 1 spec text doesn't say this explicitly the way 4.5f does, but it's the same
reasoning: once passes start chaining together, one bad housekeeping run shouldn't
take down the rest of the night. Cheap to add now, consistent with the rest of the
codebase.

**Status:** 16 tests (8 pure-logic, 8 integration against the fake backend), all
passing. `npm run pass1:dry` / `npm run pass1:live` exist. **Not yet run against
production.**

---

## PASS 0 — Reply-placeholder reconciliation: built, tested, not yet run against production

### The spec contradiction, and how it resolved (2026-07-18)

The document's own Non-negotiables say PASS 4 is *"the only exception"* to never
writing live CRMs — but PASS 0's procedural text says to update Activity_Log in
place, no Part D, no gate. Resolved with Bobby via a hybrid, grounded in the
project's own `§4.10` (the completion/reconciliation model), which explicitly names
PASS 0's Thread_ID case as one of the few auto-finalize exceptions: *"Exact matches
(an email reply captured on the same thread — §4.4 PASS 0 reconciliation) may
finalize a manual mark automatically because the match is unambiguous; but an
inferred resolution... is always proposed, never silently executed."*

**Built exactly that hybrid:**
- **EXACT Thread_ID match** → writes Activity_Log directly (closes the
  placeholder), marks the matched Thread_Staging row `PROCESSED`. No gate — it's
  confirming a fact (a string equality), not deciding one.
- **Contact+72h-window (INFERRED) match** → stages a `Reconciliation_Queue` row
  instead of writing anything. A heuristic, not a fact — §4.10's own rule applies.
- **AMBIGUOUS** (>1 fallback candidate) → placeholder stays open, the candidate
  Thread_Staging rows get tagged `recon:ambiguous` in `Brain_Notes` (col U) only —
  `Row_Status` (col V) is deliberately NOT touched, so they still flow through
  PASS 2 normally as ordinary outbound threads. Only an EXACT match "consumes" a
  Thread_Staging row out of the normal flow.
- **NO_MATCH** → nothing written. Staleness (>7 days) is tracked and reported, but
  not written anywhere — see the open item below.

### Reconciliation_Queue reuse — verified safe against real Aida code, not assumed

Before building the INFERRED path, read both `bhc-aida` files that touch this tab
(Bobby pasted them from his local clone — this repo's sandbox has no GitHub access
to the private `bhc-aida` repo):

- **`app/api/brain/reconciliation-queue/route.ts`** (the reader): `itemType` is
  read as a plain string with a comment reading *"always 'task' from PASS 2.5;
  future types reserved."* Confirms this was designed for exactly this kind of
  reuse. Nothing branches on it.
- **`app/api/brain/commit/route.ts`**'s `handleReconAction` (the writer/Accept-Deny
  handler): `Deny` and `Pass` work generically — `Item_Type` isn't even read.
  `Accept` (`close-task`), however, unconditionally requires `sourceTaskIds` to be
  non-empty and then closes Tasks_Log/Attio task rows — it would 400 on a
  `placeholder_reconciliation` row exactly as built, since there's no task to
  close.

**Consequence, scoped honestly:** PASS 0's INFERRED rows are visible in Aida and
Deny/Pass both work today. **Accept does not** — that needs a follow-up
`commit/route.ts` change (a new branch for `Item_Type === 'placeholder_reconciliation'`
that does something sensible: presumably the same Activity_Log-closing write the
EXACT-match path already does, executed on human confirmation instead of
automatically). Not built here — this repo has no write access to `bhc-aida`, and
it's a different codebase's change to review and ship.

**Row shape chosen**, reusing the confirmed-generic fields: `Item_Type =
"placeholder_reconciliation"`, `Source_Task_ID` left blank (deliberately — it's
not a task; the correlation IDs go in `Item_Description`'s prose instead, human
readable, e.g. "Placeholder ACT-... may match outbound thread ... (Thread_ID
...)"). `Evidence_Source` holds the candidate's `Thread_ID` — a legitimate reuse
of that field's existing role (real data already showed it holding an `ACT-...`
Activity_ID as evidence for a different verdict, so it's not task-specific either).
`Verdict = "LIKELY_PLACEHOLDER_MATCH"` — a new value; the reader's `verdictOrder`
gracefully defaults any unrecognized verdict to the last sort bucket rather than
erroring, confirmed from the same file. `Confidence = "medium"` — a name-overlap +
time-window match is real signal but not proof.

### Two things NOT verified — flagged rather than guessed past

**1. Timestamp format isn't live-checked at scale.** `npm run inspect:activity-log`
confirmed Activity_Log's *columns*, and one sample showed `Timestamp` as
`"3/30/2026 17:28:43"` — JS's `Date` constructor parses that fine, and
`parseTimestampMs` uses exactly that (no custom format guessing). But this wasn't
checked against Thread_Staging's `First_Email_Date`/`Last_Email_Date` columns at
all — if those come through in a different shape, `parseTimestampMs` returns
`null` and `matchPlaceholder` degrades to `NO_MATCH` rather than mismatching, so a
format problem shows up as a real drop in match rate on the first dry run, not
silent corruption. Still: check the first dry run's numbers against manual
expectations before trusting them.

**2. Exact-match "real content" for Activity_Log col J is intentionally
conservative, not extracted from the real email.** The spec says "set col J to
real content" but never specifies Raw_Emails_JSON's shape beyond the keys PASS 2
needs for dedup (`sender_email`, `recipient_email`, `cc_list` — nothing about a
body/content key). Guessing a key name here risks writing garbage into
Activity_Log, the permanent record — a worse failure than PASS 4's
`last_interaction_at` bug, since that was a derived cache, not the log itself. So
`resolveExactMatchBody` writes a clearly-labeled placeholder body identifying
which thread matched and why, explicitly not attempting body extraction, rather
than guess. **Follow-up:** once Raw_Emails_JSON's real shape is known (likely
whenever PASS 2's parsing step gets built, since it needs the same JSON), come
back and extract the real sent-email body here too.

### One more open item: no write target for stale-placeholder tagging

Spec: *"After 7 days: tag recon:stale-placeholder."* Unlike the matched/ambiguous
cases, the spec never says where this tag goes — Thread_Staging doesn't apply
(there's no candidate thread; the placeholder itself has nothing matched to tag).
`isStalePlaceholder` computes this correctly and it's surfaced in the report/
warnings, but nothing gets written to any sheet for it yet. Low stakes (a stale
placeholder just stays visibly open in Activity_Log either way), but worth a
decision before `--live` if the Slack digest or Aida should surface these
specifically rather than relying on the nightly report.

### Status

25 tests (18 pure-logic, 7 integration against the fake backend). 152/152 across
the whole repo. `npm run pass0:dry` / `npm run pass0:live` exist. **Not yet run
against production.** Next: a real dry run, same as every pass before it — check
the timestamp-parsing concern above against real numbers, and get Bobby's read on
the stale-placeholder write target before `--live`.
