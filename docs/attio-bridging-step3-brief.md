# Build brief — Attio bridging, step 3: the review card

**Drafted:** 2026-09-04
**Two repos, in order:** `bhc-routines` writes the candidates, then `bhc-aida` renders them.
**Read first:** `docs/attio-bridging-spec.md` §9, `docs/typo-variant-addendum.md`, and `src/passes/contacts-triage/duplicates.ts` (step 2, `f6b3319`).

---

## 0. What exists

Step 2 detects and classifies. It has never written to the queue — every run so far has been a dry run.

**Live population, stable across three runs:** 7 exact-name candidates (4 MEDIUM, 3 LOW, 0 HIGH) and 2 `TYPO_DOMAIN`. CRM-as-reference typo detection added zero beyond the owned-domain pair, and the reverse direction was measured at 1,224 rejected pairs — so the population is genuinely small and unlikely to grow fast.

**Nine cards. Not a queue feature — a short list.** Build for that.

> **Corrected 2026-09-04, from the live write.** The count is **18, not 9**, and the confidence split does not hold either. `7 + 2` **double-counts**: the two `TYPO_DOMAIN` records ARE two of the seven exact-name hits, so nine is more than the seven it was drawn from. And the `consolidate-unbridged` arm — 11 records, two or more unbridged records sharing one name, added in step 2 and the only arm that finds **Raymond Yang**, whose two records are both unbridged — is missing from this accounting entirely.
>
> Measured: **`DUPLICATE_CANDIDATE` 16 · `TYPO_DOMAIN` 2** — high 2, medium 5, low 11; `consolidate-unbridged` 11, `merge-into-bridged` 5, `exclude-typo-domain` 2. All 18 are written and confirmed. **Part B should be built for 18**, and for the fact that 11 are low-confidence noise (Bobby's own three addresses, CalendarBridge, MOHAI, Justin Pilla). Detail in `docs/contacts-triage-notes.md` #22.

---

## 1. Part A — write the candidates (`bhc-routines`) ✅ DONE 2026-09-04

Enable the `Contacts_Triage_Queue` write that step 2 has been holding back.

⚠ **Read the live schema first.** Do not infer column positions from any spec or brief. `Reconciliation_Queue`'s column O was a mystery for weeks because a report guessed at a width.

**Every candidate row carries**, at minimum: the unbridged `record_id`, the matched bridged `record_id`, `bhc_contact_id`, classification (`DUPLICATE_CANDIDATE` | `TYPO_DOMAIN`), confidence, the distinguishing evidence, and `dropped_second_bhc_id` where both sides are bridged.

⚠ **Dismissals must stick.** `skipUntil` and `status` already exist on this tab — use them. A candidate resolved and re-raised unchanged on the next run trains the user to ignore the queue, which costs more than the queue is worth.

**Count confirmed writes, never intended.** Seven counters were found reporting attempts rather than results in August.

---

## 2. Part B — the card (`bhc-aida`)

### Four actions

**Merge** — same person. ⚠ **Say what merge does HERE:** it consolidates both addresses onto one record. Chuck already carries six; Zoe carries two. One-record-many-addresses is the established correct state, not a compromise.

**Mint as new** — different people who share a name.

**Exclude** — neither. A role address, noise.

**Repoint** — for a record matching an `ORPHAN CLEARED` tombstone. Those annotations **name a canonical BHC_ID** (`"duplicate of BHC-01622"`), so the answer is "this is that contact", not merge or mint. 13 of 19 retired identities are `ORPHAN CLEARED`.

### `TYPO_DOMAIN` is a different card

Not four actions. **Two**, and the default is delete.

**Delete** *(default)* — the typo record has no meaningful correspondence. Nothing is lost.

**Merge and remove the wrong address** — real correspondence exists and must be preserved.

⚠ **THIS IS ONE ACTION WITH TWO STEPS AND THE SECOND GETS FORGOTTEN.** Attio's merge carries **all** addresses onto the survivor, so a merge alone *adds* the typo to a clean record. Chuck would hold seven addresses, one wrong — and **the next sweep would match against it and re-raise the same pair forever.** Show the removal step as outstanding until confirmed done. Do not present it as a follow-up the user is trusted to remember.

**Show the evidence, decide nothing:** `first_interaction`, `last_interaction`, `strongest_connection_strength`. The live pair is two days apart and `Very weak` — clearly delete. **The threshold is deliberately not automated: a rule fitted to a population of two is fitted to noise.**

### What every card shows

**Per-record `app.attio.com` links.** Attio permits no programmatic merge; the card's job is to make both sides visible in one click.

⚠ **MAKE REJECTION AS CHEAP AS ACCEPTANCE.** Three of seven name candidates are wrong. A card optimised for confirming gets wrong answers confirmed. Lead with what **distinguishes** the records — different companies, different first-interaction dates, one with a LinkedIn and one without — not only what matches.

⚠ **Name the BHC_ID that will die.** Where both sides are bridged, merging silently discards the secondary's `bhc_contact_id` — the field is `is_unique: false` and single-value, so nothing errors. Two of the four real candidates are in that state. This has already happened once: `Name_Conflicts` row 3 records an ID *"merged away 2026-08-10"* leaving Master_ID pointing at a dead record.

⚠ **Warn on company orphans.** Deleting both typo people empties company `bea3ba44`, which exists only because of the typo. Say so on the card — *"this also created company X, which will have no people after this"* — rather than leaving an invisible orphan.

---

## 3. What this is not

**No minting.** Step 4, human-confirmed. Automatic minting would have created a BHC_ID for Raymond Yang twice in three days.

**No post-merge reconciliation.** Step 5. Note the constraint now: a merge produces a new `record_id` and both originals return an identical `404` — indistinguishable from deleted or never-existed. **Survivor detection must be by email**, never by `record_id` or `bhc_contact_id`.

**No company deduplication.** Separate build — see §4.

**No `Master_ID` writes.**

---

## 4. Noted, not built: companies have the same problem

Sampling the five most recent company records, **all `created_by: system`**, found `Remote` **duplicated**: `db50a488` on `remote.com` and `5974ae14` on `payments.remote.com`. Same name, description, LinkedIn, Twitter, funding, location. Each carries one person, so the people are split too.

**The mechanism is different and cleaner than the person case: subdomain, not typo.** `payments.remote.com` *ends with* `.remote.com` — a structural relationship, deterministic, with no false-positive tail. Unlike Levenshtein it needs no threshold.

**One hit in a sample of five.** Worth its own pass; not worth growing this build. **Size the object properly before speccing it.**

---

## 5. Verify

`npm run typecheck && npm test` in routines; `npm run build` in Aida.

**Live, in order:**

1. Write the nine candidates. Confirm the count, and that the four MEDIUM, three LOW and two `TYPO_DOMAIN` land with the right classification.
2. Re-run. **Confirm nothing is re-raised** — the write must be idempotent before the card is trusted.
3. Resolve one candidate, re-run, **confirm it stays dismissed.**
4. Confirm `dropped_second_bhc_id` is present on the two candidates where both sides are bridged, and absent elsewhere.

   > **Corrected 2026-09-04.** It is present on **NONE**. Every candidate's subject is unbridged by construction, so the field can only populate when a candidate names two or more BRIDGED records; no candidate does. Four name keys in the workspace are held by two bridged records each, but none belongs to a candidate. The field is implemented and pinned by a constructed test, because the state is reachable and the data loss is silent when it occurs.
5. Confirm the company-orphan warning fires on the typo pair and nowhere else.

⚠ **Mutation-check every guard**, and report each. Two of step 1's eleven passed first time for reasons unrelated to the guard; step 2's negative-case fixture was decorative until rewritten. Both were caught by mutation-checking and neither by review.

---

## 6. Report

Candidates written and their classifications. Idempotency result. Dismissal result. Mutation-check results. And **anything the card needs that detection does not supply** — better known now than half-built.
