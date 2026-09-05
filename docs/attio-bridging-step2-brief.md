# Build brief — Attio bridging, step 2: duplicate candidate detection

**Repo:** `bhc-routines` · **Drafted:** 2026-09-04
**Read first:** `docs/attio-bridging-spec.md`, then `src/passes/contacts-triage/suppression.ts` (step 1, shipped `49cb8ef`), then `docs/contacts-triage-notes.md` #19.

---

## 0. Where this sits

Step 1 shipped: identities a human already retired are suppressed before scoring, reading `Location: SUPERSEDED` rows and `Contact_Exclusions`. It caught 2 records on its first run — both Raymond Yang — against 229 from pre-existing exclusion matching. The two signals are disjoint and 2 is the honest number.

**Step 2 detects the other half: an unbridged Attio record that is the same person as one already bridged.** It surfaces the candidate as a question. It does not merge, does not mint, does not decide.

⚠ **Attio permits no programmatic merge.** The deliverable is a card with per-record links, not an action.

---

## 1. ⚠ THE POLICY CHANGED ON 2026-09-04 AND IT CHANGES THE ANSWERS

**TNB staff and former TNB staff ARE contacts**, tier Strategic during employment and after it. The owned-domains exclusion in the project instructions is a **threading** rule — it stops Aida naming Bobby or a colleague as the external party in his own thread — not a contact-eligibility rule.

That correction is written into the project instructions and the Plan. It matters here because the largest duplicate cohort in this population is TNB staff on the Epic account, who carry both a `@thenewblank.com` and an `@xa.epicgames.com` address.

**The correct end state is ONE record with MULTIPLE addresses.** Zoe Cattolico is the worked example, live:

```
email_addresses[2]: zoec@thenewblank.com, zoe.cattolico@xa.epicgames.com
bhc_contact_id: BHC-02386 · relationship_type: Internal · tier: Strategic
```

So **merge here CONSOLIDATES ADDRESSES onto one record** — it is not elimination of a redundant entry. The spec treats merge as removing a duplicate; that framing is too narrow and the card's wording should reflect what actually happens.

---

## 2. What works, measured — and what can never work

| Signal | Unbridged records matching a bridged one |
|---|---|
| exact email | **0** |
| **exact full name** | **7** |
| name + company | 0 |
| LinkedIn URL | 0 |
| email local-part | 16 |

⚠ **DO NOT BUILD ON EXACT EMAIL.** `email_addresses` is `is_unique: true` on this workspace — **Attio structurally cannot put the same address on two person records.** A duplicate detector keyed on it would pass every fixture test and find nothing, forever. This is the same shape as `last_email_interaction`, which is defined in the schema and populated on 0 of 2506 records.

⚠ **`company_name` is populated on BRIDGED records only** — our routines write it; Attio does not. Zoe carries `The New Blank`; unbridged records carry nothing. So name-plus-company needs company on both sides and cannot work. The spec states the reason wrongly (it says the field is empty everywhere); the conclusion stands.

**Exact full name is the only viable primary signal, and it is a candidate generator, never a verdict.** Three of its seven live hits are wrong:

- `chuck@thenewblanks.com` and `lana@thenewblanks.com` — **typo domains**, trailing `s`. Misaddressed mail Attio materialised into person records. Not duplicate people, and not people.
- `"Le"` matching BHC-01225 — a one-token name collision.

**Roughly four of seven are real.** Two people can share a name and this population contains proof.

**Email local-part** is corroboration only. It catches `raymondy@` against a bridged `raymond*@`, and also every `info@` and `sales@` pair across unrelated domains.

---

## 3. Detection

**Primary: exact full name against bridged records**, reusing step 1's normaliser so the two agree on what a name is.

⚠ **Use exact set equality over significant words, NOT `verifyName`.** `verifyName` passes on one significant word in common — correct for verifying a pair a human proposed, wrong for generating them. Step 1 proved this live: `Raymond Yang` and `Raymond Worsdale`, an active contact at NBCUniversal, share one word and `verifyName` passes.

**Corroboration, raising confidence but never sufficient alone:** email local-part similarity; shared company reference (the `company.record_id`, not `company_name`); LinkedIn URL match where both have one.

**Report a confidence, not a boolean.** Name alone is weak. Name plus shared company reference is strong. Name plus a typo-domain address is a signal it is NOT a person at all.

⚠ **Detect the typo-domain case explicitly.** `thenewblanks.com` is one character from an owned domain. A near-miss on an owned domain is evidence of misaddressed mail, and those records should surface as **exclude** candidates rather than merge candidates — a different card, or at minimum a different default action.

---

## 4. Where it surfaces

**`Contacts_Triage_Queue`**, the same tab step 1 already uses. Not `Name_Conflicts` — checked, its schema requires a `BHC_ID` in column D and describes name drift for one bridged contact across two systems, where an unbridged duplicate has no `BHC_ID` and involves two records. Not `Reconciliation_Queue` — its rows are staged writes awaiting a resolve, and a suspected duplicate is a question with several answers and no write to stage. **Not a new tab** — that forks one population across two surfaces, and Raymond Yang appearing on both, resolved inconsistently, is the failure already experienced.

**Read the live schema before writing.** Do not infer column positions from the spec or from this brief.

---

## 5. The card — four actions, not three

The spec says three. The `ORPHAN CLEARED` split found in step 1 adds a fourth.

**Merge** — same person. Bobby merges in Attio by hand, then marks it done. The card must say what merge *does here*: consolidates both addresses onto one record, per §1.

**Mint as new** — different people who share a name.

**Exclude** — neither. A role address, a typo domain, noise.

**Repoint** — for records matching an `ORPHAN CLEARED` tombstone. Those annotations **name a canonical BHC_ID** (`"duplicate of BHC-01622"`), so the answer is not merge or mint but "this is that contact." 13 of the 19 retired identities are `ORPHAN CLEARED`; 6 are `SCRAPPED`. Step 1 already records which kind, so the distinction is available for free.

**Every candidate carries a direct `app.attio.com` link per record.** Merging is manual and a judgement call; the card's job is to make both sides visible in one click.

⚠ **MAKE REJECTION AS CHEAP AS ACCEPTANCE.** Three of seven live candidates are wrong. A card optimised for confirming will get wrong answers confirmed. Show what *distinguishes* the two records — different companies, different first-interaction dates, one with a LinkedIn and one without — not just what matches.

⚠ **A dismissal must stick.** A candidate resolved and re-raised unchanged on the next run trains the user to ignore the queue, which costs more than the queue is worth. `skipUntil` and `status` already exist on this tab.

---

## 6. ⚠ What a merge destroys, and why the card must warn

`bhc_contact_id` is `type: text`, **`is_unique: false`**, single-value. Attio's own documentation: the primary record's value wins where both have one; the merge produces a **new** `record_id` matching neither input; both originals become unreadable.

| Case | Outcome |
|---|---|
| unbridged + bridged | the BHC_ID survives — the unbridged side has nothing to compete |
| **two bridged records** | **the primary's BHC_ID wins, the secondary's is SILENTLY DISCARDED** — the field is non-unique, so nothing errors |
| either | **both input record_ids die**, and every `Master_ID.Attio_Record_ID` pointing at either goes stale instantly |

**Never surface a merge between two bridged records without naming which BHC_ID will be lost.** This has already happened: `Name_Conflicts` row 3 records an ID *"merged away 2026-08-10"* leaving Master_ID pointing at a dead record whose cached row had drifted to hold a different person.

**And a merge is undetectable afterwards.** Four record IDs were probed: a deleted record, a stale A3 pointer, and a never-existed ID all return an identical `404 not_found`. **No redirect, no `deleted_at`, no tombstone.** Nothing distinguishes "merged" from "deleted" from "never existed", which is why A3's *"deleted or merged"* wording should not be tightened.

**So post-merge survivor detection must be BY EMAIL**, never by `record_id` and never by `bhc_contact_id`.

---

## 7. Scope — detection only

**Do NOT build minting.** That is step 4 and it is human-confirmed for a reason: automatic minting would have created a BHC_ID for Raymond Yang twice in three days, plus two typo domains and 22 GLG solicitation addresses.

**Do NOT build the post-merge reconciliation.** Step 5.

**Do NOT write to `Master_ID`.** Step 2 reads it and writes nothing to it.

---

## 8. Verify

`npm run typecheck && npm test`.

**Fixtures from the real response shape**, including a typo-domain record and a one-token name collision. Idealised fixtures have four times this month produced tests that passed without exercising what they named.

⚠ **MUTATION-CHECK EVERY GUARD** — neuter it, confirm the test fails, restore it, confirm it passes. Step 1 ran eleven and **two passed on the first attempt for different reasons**: one test was decorative until a period-free fixture was added, one mutation hit a TDZ error rather than running. Catching those is what made the other nine trustworthy.

**Live, dry-run first, and do not write to the queue until reviewed:**

1. Report every candidate group with its confidence and what distinguishes the records.
2. **Confirm the seven exact-name hits reproduce**, and that the three known-wrong ones are flagged low-confidence or as exclude candidates. If the count has moved materially from seven, report before proceeding — the population changes daily.
3. Confirm `verifyName` is not used anywhere in the detection path.
4. Confirm no `Master_ID` write occurs.

---

## 9. Report

Candidate groups with confidence. Whether the seven reproduce. How the typo-domain pair is classified. Mutation-check results. What you would need for step 3's card that detection cannot supply.

**If exact name produces materially more or fewer than seven, report before building the card** — the filter design rests on that shape.
