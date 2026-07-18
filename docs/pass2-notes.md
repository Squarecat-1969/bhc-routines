# PASS 2 — implementation notes

Companion to `src/passes/pass2/`. Mirrors the other passes' notes format.

**Status: fully built and tested (271/271 across the whole repo), including the
orchestration and CLI. Not yet run against production — same next step as every
pass before it.**

---

## What's built

- **The enrichment call itself (spec step "e"/"e2") — `enrich.ts`, `enrich-schema.ts`,
  `prompt.ts`, and `src/lib/anthropic.ts`.** One narrow, single-purpose Anthropic
  call per thread, fixed JSON schema, matching the project's own stated LLM
  principle. Three real safety properties, not just prompting:
  - **`zod` schema rejection, not hopeful prompting, for the spec's explicit
    warning** about `key_commitments` ("never a participant-keyed object...
    crashes the Aida UI with React error #31") — if the model returns an
    object instead of a string, `.safeParse()` fails before it ever reaches a
    sheet. Test asserts this exact failure shape gets rejected.
  - **A deterministic guard for the spec's named "most common misfire"**: on
    an Outbound thread, `REPLY_NEEDED` gets downgraded to `FYI_ONLY` (and
    `response_draft` cleared) rather than trusted from the model, with a
    visible warning every time it fires. The spec's own language ("almost
    always wrong," "wrongly assigns") describes a known systematic error to
    actively correct, not just hope the prompt prevents.
  - **Guardrail redaction applied to every free-text output field** — defense
    in depth in case the model echoes something sensitive it saw in the raw
    thread into a summary/notes field, separate from the guardrail's role as
    an input-side safety net.
  - Code-fence stripping (models sometimes wrap JSON in ` ```json ` despite
    instructions not to) and malformed-response handling — never throws, the
    caller gets a clear `ok:false` outcome to skip or retry.
- **`parse-emails.ts`** — `Raw_Emails_JSON` parsing, deduped by `email_msg_id`
  (spec 2a). Two real findings from a live Thread_Staging read (checking PASS
  0/1's dry-run numbers, 2026-07-18), not guesses:
  - `cc_list` is **not** valid JSON or a clean array — real values look like
    `"emailAddress: {'address': 'x@y.com', 'name': 'X Y'}\n\nemailAddress: {...}"`,
    a Python-dict-repr string, newline-joined for multiple entries. `parseCcList`
    extracts via regex, with a JSON.parse attempt first as a defensive fallback
    in case some rows differ.
  - `recipient_email` was blank on every inbound sample message seen. Matters
    for the "principal recipient" resolution on outbound threads — see the
    fallback chain in `participants.ts`.
- **`participants.ts`** — primary/secondary identification (spec 2b) and the
  test/placeholder guard (2a2, narrow lorem-ipsum/obvious-test patterns only,
  not a general quality filter).
- **`contacts-email-map.ts`** — the email→BHC_ID map spec 2b's Contacts schema
  note asks for, resolved by header title (not hardcoded letters), plus a
  `contactIdByGoogleRow` index for the drift check's Google-side verification,
  built from the same wide read.
- **`resolve.ts`** — the full three-step cascade (Contacts → Attio by email →
  Master_ID cross-reference → new-contact candidate, never fabricating a
  BHC_ID) and the drift check (Google col A vs. Master_ID BHC_ID; Attio
  `bhc_contact_id` vs. Master_ID BHC_ID). This is the highest-stakes code in
  this batch — it's the same class of identity logic that, when missing a
  check, caused the June 2026 corruption incident (82 contacts silently
  mispointed). Tested against a fake Attio backend covering every cascade
  branch and every drift combination (both clean, Google-only-mismatch,
  Attio-only-mismatch, and neither side applicable for an unresolved contact).
- **`triage.ts`** — NO_ACTION bucket heuristics (sensitive/automated/cold/vendor).
  Deliberately conservative: the spec names four categories but gives no
  detection rules for any of them, so this only catches high-confidence
  patterns (no-reply senders, medical keywords, vendor support addresses, cold-
  outreach subject lines) and returns "not noise" for anything it doesn't
  recognize — meaning ambiguous content correctly falls through to the LLM
  enrichment step rather than getting force-classified by a regex.
- **`guardrail.ts`** — the HARD DATA GUARDRAIL (spec 2d) as a pattern-based
  safety net: Luhn-validated credit card numbers, SSN shape, labeled API keys,
  labeled passwords. Explicitly a safety net, not a substitute for the LLM
  step's own judgment — a regex catches "SSN: 123-45-6789," not a paraphrase.
- **`write-targets.ts`** — the full `Write_Targets_JSON` assembly (spec 2f),
  a pure function over already-computed content so it's ready to receive real
  enrichment output — and now does, from `enrich.ts`. Enforces every rule the
  spec states: omit entirely when primary BHC_ID is unresolved; include
  google/attio blocks per Master_ID Location only; withhold just the drifted
  side on a drift tag (not the whole primary); `personal_context` included
  only when at least one extract is non-empty, omitted (not sent as a blank
  block) otherwise; secondaries never carry `personal_context`, enforced at
  the type level as well as by construction. Column letters
  (BZ/CA/CB/CD/CE/CG) cross-checked against `bhc-aida`'s own `commit/route.ts`
  `WRITABLE` map — Bobby pasted that file earlier tonight for the unrelated
  PASS 0 question, and it happens to confirm these letters and field names
  exactly. Not a guess.

## The orchestration (`index.ts`) — real design decisions made building it

- **Fail-soft is per-thread, not just per-pass.** An enrichment failure (bad
  API response, malformed JSON, a network error) skips just that thread —
  it's left unprocessed (Thread_Staging NOT marked PROCESSED), so it's
  naturally retried on the next run. Consistent with "when in doubt, leave it
  open" throughout this project, and a meaningfully different failure mode
  than PASS 4/4.5's per-contact skip, since here the *entire remaining
  content* for a thread depends on one LLM call succeeding, not a handful of
  independent field writes.
- **Building this surfaced a real gap:** the enrichment schema was missing
  `outcome` (Google's CG / `Last_Interaction_Outcome`) entirely — `Write_Targets_JSON`
  needs it and nothing was producing it. Added to `enrich-schema.ts` (importing
  `OUTCOME_VALUES` from `write-targets.ts` as the single source of truth,
  rather than defining the enum twice) and to the prompt's requested JSON
  shape. Caught by trying to actually wire the pieces together — exactly the
  kind of gap that unit tests on isolated pieces don't surface, but an
  integration attempt does.
- **Secondaries are not drift-checked**, per the spec's own scoping ("DRIFT
  CHECK (per resolved contact after cascade)" appears in the context of the
  primary's resolution walkthrough, not repeated for secondaries). Treated as
  clean by default in `Write_Targets_JSON` assembly; `includeAttio`'s own
  Location check still gates whether a secondary's Attio block gets written
  at all, so an unresolved or Google-only secondary still can't produce a
  spurious Attio write.
- **The Contacts wide read is now shared across three purposes** in one pass
  (email→BHC_ID map, the Google-side drift check's col-A index, and
  Personal_Notes/Topics_of_Interest/Conversation_Trigger for response
  drafting) — `contacts-email-map.ts` grew to cover all three from the same
  single read, per the spec's own explicit efficiency note ("Extract AI, AU,
  and AV for each contact from this same bulk read by google_row — never make
  additional per-contact cell reads for these fields. Zero extra Sheets
  calls").
- **Channel is hardcoded to `"Email"`** in the Write_Targets interaction
  content — not something the LLM produces. Thread_Staging is specifically
  the email capture pipeline (other channels like LinkedIn/Zoom get captured
  differently, per the ROS architecture), so this isn't a judgment call, just
  a known constant for this pass.

## Two things flagged rather than guessed past

1. **`searchPeopleByEmail`'s filter syntax is unverified against live Attio.**
   Spec: `filter {"email_addresses": {"$contains": "<email>"}}`. Same
   REST-vs-MCP-transport deviation as `listEntries`/`fetchPersonRecordsBatched`
   (see `attio.ts`'s own comments) — but unlike those, a query-with-filter call
   has never actually been checked against production. `getPersonRecord`/
   per-record GETs are proven (PASS 4's `--dump-shapes` and canary write);
   this specific query shape is not. First real check happens on the first
   live dry run against a thread with an unresolved-in-Contacts participant.
2. **The `principal recipient` fallback chain for outbound threads is an
   inferred design choice, not spec text.** Given real data shows
   `recipient_email` often blank, `participants.ts` falls back to the most
   recent outbound message's cc list, then to the most-frequently-appearing
   external address across the whole thread. Reasonable, but worth revisiting
   once real outbound-thread data is actually run through it — the spec gives
   no fallback rule at all, so this is filling a real gap, not implementing
   one.
3. **`ENRICHMENT_MODEL` (`claude-sonnet-5`) is a reasonable default, not a
   confirmed decision.** The enrichment call involves real judgment (the
   outbound-ceiling rule, restraint against hallucinating personal context,
   drafting in Bobby's authentic voice) run nightly across potentially many
   threads — a real cost/quality tradeoff Bobby should confirm rather than
   have picked for him silently. Easy to change in one place
   (`src/config/constants.ts`) once he weighs in.
4. **`npm run pass2:dry` still calls the real Anthropic API.** Unlike every
   other pass, PASS 2's dry-run can't be fully free — the only way to see real
   enrichment output is to actually call the model. It skips every Sheets
   write (zero data risk), but it does spend real API cost. Worth running with
   `--limit` first.

## First live dry run (2026-07-18, `--limit 3`) — real findings, one real fix

Ran against 3 real threads from tonight's Thread_Staging working set. Confirmed
correct on real data: the Contacts column resolution (`Personal_Notes=AI`,
`Topics_of_Interest=AU`, `Conversation_Trigger=AV` — item flagged as unverified
above is now confirmed), the email map (36 emails from 2,855 real Contacts
rows), and the working-set filter (17 real threads found).

**2 of 3 threads went all the way through cleanly** — resolved, enriched,
wrote a full Brain_Complete row with a valid `Write_Targets_JSON`.

**1 of 3 failed with `"Unterminated string in JSON"`** — the classic signature
of hitting `max_tokens` mid-response. The fail-soft design worked exactly as
intended: caught cleanly, left unprocessed for automatic retry, nothing
corrupted or half-written. But the failure message only showed the parse
error, not what the model actually returned, making it hard to confirm the
truncation theory or diagnose a different future failure without re-running.

**Fixed both:**
- `ENRICHMENT_MAX_TOKENS` raised `2000 -> 4000`. A real, evidence-based change
  (this is the second time tonight a limit got tuned from live data rather
  than guessed at upfront — same pattern as PASS 4.5's batch-size tuning).
- `EnrichmentOutcome`'s failure case now carries a `rawPreview` (the last 300
  chars of whatever the model actually returned, plus total length) — surfaced
  directly in the orchestration's warning line, so a future failure is
  diagnosable from the report alone, not just "this failed, rerun and hope."
  2 new tests lock this in, including one that reproduces the exact
  truncation shape hit here.

**Not yet re-verified**: whether 4000 tokens is enough — that needs another
live run to confirm the same 3 threads (or a wider `--limit`) now succeed.

## Status

129 PASS 2 tests (pure-logic, against the fake Attio/Sheets backend, against a
fake Anthropic backend individually, and a full end-to-end orchestration
suite exercising all three fakes together — noise paths skip the LLM
entirely, a real relationship thread produces a complete Brain_Complete row
with a valid Write_Targets_JSON, dry-run calls Anthropic but writes nothing,
an enrichment failure leaves the thread unprocessed, drift withholds only the
drifted CRM side while still writing the row, `--limit` caps the working set,
and the pass never throws on a systemic failure). 271/271 across the whole
repo, typecheck clean. `npm run pass2:dry` / `npm run pass2:live` exist.

**Not yet run against production.** Same next step as every pass before it —
though see the "npm run pass2:dry still calls the real Anthropic API" note
above; this one has a real cost the others didn't.
