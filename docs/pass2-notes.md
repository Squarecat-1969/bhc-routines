# PASS 2 — deterministic half: implementation notes

Companion to `src/passes/pass2/`. Mirrors the other passes' notes format.

**Status: building blocks AND the enrichment call are built and tested (91 tests),
not yet wired into a runnable orchestration/CLI — see "What's NOT here" below.**

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

## What's NOT here yet, and why that's the right boundary

**No orchestration (`index.ts`) or CLI for PASS 2 yet.** Every building block
exists now — parsing, resolution, drift, triage, the guardrail, the real
enrichment call, and the Write_Targets assembly — but nothing wires them
together into a runnable pass over a real working set, writes the actual
Brain_Complete row (A–AD, which requires carrying forward Thread_Staging's own
A–U alongside the new enrichment values for the enriched columns), builds the
per-thread Slack block (2g2), or marks Thread_Staging PROCESSED (2h). That's
real, substantial glue work — genuinely lower-risk than what's built so far
(no new identity-resolution logic, no new LLM-safety design), but still a
meaningful chunk of orchestration and a new Brain_Complete row-builder that
hasn't been scoped yet. Next session's natural starting point.

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
3. **`ENRICHMENT_MODEL` (`claude-sonnet-5`) is a reasonable default, not a
   confirmed decision.** The enrichment call involves real judgment (the
   outbound-ceiling rule, restraint against hallucinating personal context,
   drafting in Bobby's authentic voice) run nightly across potentially many
   threads — a real cost/quality tradeoff Bobby should confirm rather than
   have picked for him silently. Easy to change in one place
   (`src/config/constants.ts`) once he weighs in.

## Status

91 tests (all pure-logic, against the fake Attio/Sheets backend, or against a
fake Anthropic backend — no production dry run possible yet, per the boundary
above). 243/243 across the whole repo, typecheck clean.
