# PASS 2 — deterministic half: implementation notes

Companion to `src/passes/pass2/`. Mirrors the other passes' notes format.

**Status: building blocks built and tested (62 tests), not yet wired into a runnable
orchestration/CLI, and deliberately so — see "What's NOT here" below.**

---

## What's built

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
  enrichment output once the LLM half exists. Enforces every rule the spec
  states: omit entirely when primary BHC_ID is unresolved; include google/attio
  blocks per Master_ID Location only; withhold just the drifted side on a
  drift tag (not the whole primary); `personal_context` included only when at
  least one extract is non-empty, omitted (not sent as a blank block)
  otherwise; secondaries never carry `personal_context`, enforced at the type
  level (their interface has no such field) as well as by construction.
  Column letters (BZ/CA/CB/CD/CE/CG) cross-checked against `bhc-aida`'s own
  `commit/route.ts` `WRITABLE` map — Bobby pasted that file earlier tonight for
  the unrelated PASS 0 question, and it happens to confirm these letters and
  field names exactly. Not a guess.

## What's NOT here yet, and why that's the right boundary

**No orchestration (`index.ts`) or CLI for PASS 2 yet.** Every other pass
(4, 4.5, 1, 0) got a runnable `npm run passN:dry` the moment its logic was
built, because each of those could meaningfully do *something* useful in
dry-run against real data on day one. PASS 2 is different: the actual
enrichment content — `Running_Summary`, `Action_Required`, `Response_Draft`,
`Tasks_JSON`, the personal-context extracts — all require an LLM call per the
spec's own step "e." None of that exists yet. Wiring an orchestration around
these building blocks without it would either (a) only handle the small slice
of threads that resolve straight to `NO_ACTION` via the test-guard or triage
heuristics, which isn't a meaningful dry run of the pass, or (b) require
stubbing the enrichment content with placeholders, which risks looking like a
real dry run when it isn't.

This matches the migration order's own framing (`CLAUDE.md`: "2 (deterministic
half) → 2's LLM calls") — these were always meant to be two separate build
steps, not because the deterministic half is somehow easier, but because it's
a genuinely different kind of engineering work. Everything above is ordinary
TypeScript logic and Sheets/Attio I/O, the same shape as every pass before it.
The LLM half is prompt design and Anthropic API integration against the
project's own stated constraint ("LLM calls stay narrow. Single-purpose
Anthropic API calls with a fixed JSON schema, one well-defined task each") —
worth its own dedicated session rather than folding into this one.

## Two things flagged rather than guessed past

1. **`searchPeopleByEmail`'s filter syntax is unverified against live Attio.**
   Spec: `filter {"email_addresses": {"$contains": "<email>"}}`. Same
   REST-vs-MCP-transport deviation as `listEntries`/`fetchPersonRecordsBatched`
   (see `attio.ts`'s own comments) — but unlike those, a query-with-filter call
   has never actually been checked against production. `getPersonRecord`/
   per-record GETs are proven (PASS 4's `--dump-shapes` and canary write);
   this specific query shape is not. First real check should happen once PASS
   2's orchestration exists and can run a dry pass against a handful of real
   threads.
2. **The `principal recipient` fallback chain for outbound threads is an
   inferred design choice, not spec text.** Given real data shows
   `recipient_email` often blank, `participants.ts` falls back to the most
   recent outbound message's cc list, then to the most-frequently-appearing
   external address across the whole thread. Reasonable, but worth revisiting
   once real outbound-thread data is actually run through it — the spec gives
   no fallback rule at all, so this is filling a real gap, not implementing
   one.

## Status

62 new tests (all pure-logic or against the fake Attio/Sheets backend — no
production dry run possible yet, per the boundary above). 214/214 across the
whole repo, typecheck clean.
