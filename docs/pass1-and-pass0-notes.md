# PASS 1 (built) & PASS 0 (blocked on two open questions) — implementation notes

Companion to `src/passes/pass1/`. Mirrors `docs/pass4-notes.md`/`docs/pass4_5-notes.md`'s
format.

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
production** — same next step as every other pass before it: a real dry run to
confirm the column assumptions hold (these two, unlike Activity_Log's, come
straight from the spec's own explicit schema, so lower risk than usual — but
"lower risk" isn't "verified," and `last_interaction_at` was also "should be
fine" until it wasn't).

---

## PASS 0 — Reply-placeholder reconciliation: NOT built yet, two real open questions

### 1. The spec appears to contradict its own architecture — needs Bobby's call

The document's own framing paragraph says: *"For PASS 0–3 (Thread_Staging →
Brain_Complete): you do not touch the live CRMs. A separate handler (Part D)
writes those to Activity_Log, Contact_History, and Attio only after Bobby
resolves your digest."* The Non-negotiables section is even more explicit:
*"Never write to live CRMs. Write only to Brain_Complete; mark Thread_Staging
PROCESSED. Part D writes on resolve,"* immediately followed later by *"PASS 4
writes directly to Attio — this is the **only** exception to Non-negotiable #1
for live-CRM writes."*

But PASS 0's own procedural steps say: *"On a match: update placeholder row in
place (set col J to real content, col N to Replied, clear PENDING_CAPTURE from
col P)."* That's a direct write to Activity_Log — the permanent record — with no
digest, no Part D, no gate. Every other pass in 0–3 (PASS 2 especially) stages
everything into `Write_Targets_JSON` for Part D to execute; PASS 0 is the one
place in the whole spec that describes writing live outside PASS 4's explicitly
carved-out exception.

**This isn't a wording nitpick — it's a real safety-architecture question**, and
one the project's own rules say needs a human call, not an inferred one: "Writes
are human-gated where they carry judgment" is a Hard Contract, and Activity_Log
is explicitly the one place permanence lives. I don't think this is close enough
to PASS 4's "mechanical computation, not a judgment call" carve-out to assume the
same exception applies by analogy — PASS 4 writes three numbers computed from a
formula; PASS 0 is deciding "this placeholder is now resolved and here's its real
content," which reads more like exactly the kind of thing Part D exists to gate.

**Two live options, not a recommendation to pick one without you:**
- **(a) Stage, don't write.** PASS 0 finds the match and proposes the resolution
  (real content, Replied, cleared PENDING_CAPTURE) the same way PASS 2 proposes
  everything else — into some staging mechanism Part D executes. Consistent with
  Non-negotiable #1 and the framing paragraph. Requires designing that staging
  mechanism, since nothing pre-existing fits (`Write_Targets_JSON` lives on
  Brain_Complete rows, which PASS 0 doesn't create — see question 2 below).
- **(b) Treat this as a second deliberate exception**, same class as PASS 4:
  closing a placeholder with a deterministic match (exact Thread_ID, or a tight
  contact+72h window) arguably is mechanical, not judgment — the "judgment" (that
  Bobby should reply to this thread at all) already happened when he clicked
  "Open reply." If so, this pass should get its own explicit Non-negotiable
  carve-out written down, the way PASS 4 has one, rather than reading past a
  contradiction silently.

> **Decision needed:** which of (a) or (b) — and if (a), what staging shape (see
> question 2 immediately below, since they're really the same question from two
> angles).

### 2. Activity_Log's exact column layout is never spelled out in the spec

Thread_Staging and Brain_Complete both get an explicit `A ... · B ... · C ...`
schema line. Activity_Log doesn't — PASS 0 just references "col J," "col N,"
"col P" as if the layout is already known. Memory notes list named fields
(Activity_ID, timestamp, contact, channel, direction, subject, body, outcome,
next-action, source, created-by, source-CRM, Attio-task-id, hook-used) but not
their exact letter positions, and a naive left-to-right mapping of that list
doesn't land "body" on J the way the spec implies — meaning either the real
column order differs from that list's order, or there are unlisted columns in
between.

**Guessing here is exactly the mistake class already hit twice tonight**
(`last_interaction_at`, the narrow Contacts range) — both were "should be fine"
assumptions that failed silently. Activity_Log is higher-stakes than either of
those: it's the permanent record, not a derived cache.

**Built, not yet run:** `npm run inspect:activity-log` — a read-only
reconnaissance script, same spirit as `--dump-shapes`. Two Sheets reads only
(header row + three sample data rows), zero writes, zero risk. Prints the real
header titles and letter positions, plus what's actually in "col J" etc. on real
rows, so the next PASS 0 design conversation has real data instead of inference
from an incomplete memory summary.

> **Next action:** run `npm run inspect:activity-log`, bring the real column
> layout back, and use it alongside question 1's decision to actually design
> PASS 0 — no matching logic should get written against assumed letter positions
> before this.
