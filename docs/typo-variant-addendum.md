# Spec addendum — typo-variant reconciliation and company orphans

**Drafted:** 2026-09-04 · **Repo:** `bhc-routines`
**Amends:** `docs/attio-bridging-spec.md` and `docs/attio-bridging-step2-brief.md` §3
**Status:** step 2 shipped (`f6b3319`) with owned-domain typo detection only. This extends it.

---

## 1. What shipped, and the limit in it

Step 2 classifies `TYPO_DOMAIN` by Levenshtein against the **owned domains**. Two hits, both correct: `chuck@thenewblanks.com` and `lana@thenewblanks.com`.

> **Corrected 2026-09-04.** This paragraph originally read *"Levenshtein ≤2 against the owned domains — `thenewblank.com`, `hougham.us`."* Both details are wrong about what `f6b3319` actually shipped. The radius is **≤1**, not ≤2 (`TYPO_DOMAIN_MAX_DISTANCE = 1`, pinned by a test: `thenewblanks.co` is two edits and is deliberately not flagged). And `OWNED_DOMAINS` holds **`thenewblank.com` only** — `hougham.us` appears in `OWNED_EMAILS` as `bobby@hougham.us` and is not a domain-level owned entry. Adding it would also change `isInternalDomain`, i.e. who gets hard-excluded, so it is not a free edit. The conclusion — two hits, both correct — is unchanged.

**That works only where we have ground truth.** An owned domain is known-correct by definition. For an external domain there is no reference — `raymond@epicgames.com` against `raymond@epicgame.com` is undecidable without one.

**The CRM itself is the reference set.** An address already on a bridged record is, by construction, one that has been used and worked. A near-variant of it arriving fresh from Attio's sync is a typo candidate.

---

## 2. ⚠ THE ASYMMETRY THAT MAKES THIS SAFE

**Same local-part, near-miss DOMAIN → almost certainly a typo.**
`chuck@thenewblank.com` vs `chuck@thenewblanks.com`. A domain is shared by many people; an exact local-part match across a one-character domain difference is very unlikely to be two different humans.

**Same domain, near-miss LOCAL-PART → probably two different people.**
`jim@acme.com` vs `tim@acme.com` is Levenshtein 1 and they are colleagues. `raymondy@` vs `raymondz@` likewise.

**So the signal is: exact local-part match AND domain within Levenshtein ≤2 of a domain already present in the CRM.** Never the reverse. Never both varying at once.

⚠ **Do NOT extend this to local-part variance.** It is the same failure mode as `verifyName` — a signal that looks symmetric and is not. Two people at one company differing by a character is common; one person with two near-identical domains is not.

---

## 3. The action depends on what is attached

**No meaningful correspondence → DELETE the typo record.** Nothing is lost, and merging would carry a wrong address onto a clean one.

**Real correspondence → MERGE to preserve the history, THEN REMOVE the wrong address from the survivor.**

⚠ **THE SECOND STEP IS THE ONE THAT GETS FORGOTTEN, AND IT IS NOT OPTIONAL.** Attio's merge carries **all** addresses onto the survivor. A merge alone therefore *adds* the typo to a clean record. Chuck currently holds six correct addresses; merging the typo in without removing it leaves seven, one wrong — and **the next duplicate sweep matches against it and re-raises the same pair forever.**

The card must present merge-and-remove as **one action with two steps**, not a merge with a follow-up the user is trusted to remember. Show the second step as outstanding until it is confirmed done.

### The threshold — deliberately not automated yet

The live population is **two records**. A rule fitted to a sample of two is a rule fitted to noise.

**Show the evidence and let Bobby decide:** `first_interaction`, `last_interaction`, `strongest_connection_strength`. **Default the action to DELETE, allow override to MERGE.**

For calibration, the Chuck typo: created 2026-06-23 22:43 by system, first interaction the same minute, last 2026-06-25 16:26, `Very weak`. Two days, one thread. Clearly delete.

**Revisit the threshold when the population is large enough to fit one.** Note the mechanism if it is ever automated: Attio exposes `first_interaction` and `last_interaction` timestamps, not an interaction count — so the tractable rule is a **span** (first and last within a day or two means one thread), not a count.

---

## 4. ⚠ A TYPO CASCADES — IT CREATES COMPANY RECORDS TOO

**One misaddressed email on 2026-06-23 at 22:43:05 produced THREE records**: two person records — `chuck@thenewblanks.com` and `lana@thenewblanks.com`, identical `created_at` to the second — and **one company record, `bea3ba44`**, which exists only because of the typo.

The real Chuck points at company `413d6127`. The two typo people point at `bea3ba44`.

**Duplicate detection has been person-only. Companies have the same problem and nothing looks at them.**

**Two consequences:**

**Deleting both typo people orphans `bea3ba44`** — a company with no people, referenced by nothing, invisible to every sweep. The card should say so: *"this also created company X, which will have no people after this."* Better surfaced now than discovered in a sweep months later.

**And the company object needs its own duplicate sweep.** Out of scope here, but record it: the same auto-creation mechanism that produced 251 unbridged people is producing company records nobody has counted. **Measure the company object's size and how many were `created_by: system` before deciding whether it needs its own pass.**

---

## 5. What this does not change

**Exact email remains useless as a duplicate signal.** `email_addresses` is `is_unique: true` — Attio cannot put one address on two records. Typo detection works precisely *because* the addresses differ; it is not a duplicate-email check by another name.

**`verifyName` stays out of the detection path.** Unchanged.

**Detection still writes nothing.** Delete and merge are both manual acts in Attio; this surfaces the question and the evidence.

**One record with many addresses remains the correct end state.** Chuck's six are right. The typo is an anomaly, not evidence against the pattern.

---

## 6. Build order

1. ✅ **DONE — 2026-09-04. CRM-as-reference typo detection** — exact local-part, domain within Levenshtein ≤2 of any domain present on a bridged record. `crmTypoHits` in `src/passes/contacts-triage/duplicates.ts`.

   **It surfaces ZERO candidates beyond the two owned-domain hits.** Measured live against 2,510 people / 2,255 bridged / 255 unbridged: the arm finds Chuck and Lana — the same two records — by a route that never consults the owned-domain list, and finds nothing else. The population did not change shape, so §3's card design still rests on two records. Detail in `docs/contacts-triage-notes.md` #21.
2. **Merge-and-remove as one action** in the card, with the removal step tracked until confirmed.
3. **Company-orphan warning** on any card whose action would empty a company.
4. **Company-object sizing** — measure before speccing a sweep.

---

## 7. Verify

⚠ **Report the candidate count from step 1 before building anything else.** If CRM-as-reference surfaces materially more than the two owned-domain hits, the population changed shape and the card design rests on it.

⚠ **Test the asymmetry explicitly**: a fixture with same-domain near-miss local-parts must produce **zero** typo candidates. That is the guard against the failure mode this design exists to avoid, and a test that only exercises the positive case would pass without it.

**Mutation-check every guard.** Two of step 1's eleven passed on the first attempt for reasons unrelated to the guard — one test was decorative until a period-free fixture was added, one mutation hit a TDZ error rather than running.
