# Build spec — Attio bridging and duplicate surfacing

**Drafted:** 2026-09-01 · **Repo:** `bhc-routines` (the pass), `bhc-aida` (the surface)
**Grounded in:** the investigation of 2026-09-01, whose measurements are quoted throughout. Every number here was measured, not estimated.

---

## 1. The problem, stated precisely

**Attio auto-creates person records from email and calendar sync.** `created_by.actor_type: "system"` on all 251 unbridged records — zero created by any routine. One burst of 170 on 2026-07-22, then roughly one a day since. Two arrived on the morning this was written.

**The Reconciler cannot see them, and the mechanism is narrower than this spec first stated.** `pass4/index.ts:279` iterates `attio.listEntries(ATTIO_PIPELINE_LIST)` — roughly **44 pipeline entries** — and uses Master_ID only as a lookup index (`master.byAttioRecordId.get(entry.recordId)`). The candidate set is the pipeline list, not Master_ID.

So **PASS 4 examines 44 of 2,506 people.** An unbridged record is invisible because **it is not on the pipeline list**, not because a Master_ID filter excluded it. This is not a missing check; it is a candidate set that structurally cannot contain them — and the blind spot is *wider* than a Master_ID-shaped one would be, because being in Master_ID would not help either.

> **Corrected 2026-09-01.** The original text read: *"Its PASS 4 candidate set is `master.rows.map(r => r.attioRecordId).filter(id => id !== '')` — it fetches only Attio records already in Master_ID."* That described a Master_ID-derived candidate set. The conclusion is unchanged; the scope of the gap is larger than it described.

So "2,472 checked · 0 findings" is a true statement about **Master_ID** and says nothing about Attio's 2,506 people.

⚠ **`pass4/load.ts:54` skips rows with a blank BHC_ID** (`if (bhcId === '') return`). Every one of the 19 retired identities in §2 has a blank BHC_ID, so that loader cannot see the rows suppression depends on. **This is why STEP 1b reads `Master_ID!A2:F` directly rather than reusing `loadMasterId`** — reusing it would have produced an empty suppression index and a silently disabled gate.

**Two gaps compound.** Unbridged inflow, and undetectable duplicates — because a record outside the candidate set cannot be compared against anything.

---

## 2. ⚠ THE ACTUAL PROBLEM IS NOT DUPLICATES

> Raymond Yang was **deliberately scrapped on 2026-08-05** — *"TNB staff, not an external contact"* — with the reasoning written into two Master_ID rows, his Attio record deleted by hand and Contacts row 383 emptied.
>
> **Attio has since re-created him twice.** 2026-08-30, and again 2026-09-01.

Nothing consults a prior human decision before a re-created record enters triage. **He will keep coming back**, and so will everyone else who was ever retired. June Yang, bridged as BHC-01917, already has an unbridged twin created the same day as Raymond's.

**This is the highest-value thing in the build.** Duplicate detection is worth having; suppression against scrapped identities is what stops the same decision being demanded every week.

⚠ **The rows set to `Location: SUPERSEDED` on 2026-08-30 are what make this possible.** That cleanup was framed as noise reduction — it also created the memory this pass reads.

### ⚠ SUPERSEDED IS THREE THINGS, NOT ONE

This spec assumed `Location: SUPERSEDED` marked a retired identity. Measured live, the 31 SUPERSEDED rows are **three different shapes**, and only one of them is a suppression signal:

| Shape | Count | A suppression source? |
|---|---|---|
| blank BHC_ID + name in **column B** | **19** | **yes — the signal** |
| BHC_ID in column A, **column B blank** — `Merged into BHC-01195 · 2026-08-10 · was Jenny Kim` | 11 | **no.** That person still exists under another BHC_ID. They were renumbered, not retired |
| **both populated** — row 962, `BHC-00920` **Rachel Marantz**, annotation `A3-FIXED` | 1 | **no.** An **ACTIVE bridged contact** whose Location was set during the 2026-08-30 cleanup |

Of the 19, **13 are annotated `ORPHAN CLEARED` and 6 `SCRAPPED`** — and the distinction matters downstream. `SCRAPPED` means the person does not belong in this CRM at all (staff, unrecognised). `ORPHAN CLEARED` means they *are* tracked, under a canonical BHC_ID the annotation names. Step 2 should turn an `ORPHAN CLEARED` suppression into a **repoint** candidate rather than a plain dismissal; STEP 1b records the kind so that does not have to be re-derived.

**Blank column A is load-bearing, not incidental.** Row 962 is the proof: Rachel Marantz is a live bridged contact, and a name match against her row would have suppressed her — hiding a real contact silently, which is the one failure direction this pass cannot afford. The gate is therefore `blank column A AND non-blank column B`, and it yields exactly the 19.

⚠ **Names must be read from column B ONLY, never parsed out of the annotation.** The 11 merge tombstones carry their name *only* inside the note, after the ` · ` separator (`· was Jenny Kim`). Harvesting names from note prose readmits all 11 through the exact door the column-B rule closes.

### Measured outcome — suppression shipped 2026-09-01 (`49cb8ef`)

First live run: **251 unbridged → 231 suppressed, 20 survive.** But the headline is not the result, because the two signals are **disjoint**:

| Signal | Suppressed | New? |
|---|---|---|
| `Contact_Exclusions` — 228 by record id, 1 by email | 229 | no — this matching already existed |
| `Master_ID` SUPERSEDED | **2** | **yes — the new capability** |
| both | 0 | |

**The honest attribution: the new half caught 2 records, and both are Raymond Yang** — `raymond.yang@xa.epicgames.com` and `raymondy@thenewblank.com`, each suppressed against Master_ID rows 456 and 1585, each quoting *"SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact"*.

**The other 17 retired identities have no re-created Attio record today.** Two is the real value of this step, and reporting it as 231 would be claiming credit for a gate that already existed.

**Two is also the right number to have built for.** It is precisely the case this section was written around — the one that had already cost the same decision twice in three days — and the other 17 are now covered *before* they come back rather than after.

---

## 3. What the 251 actually are

| | |
|---|---|
| email address | 251 (100%) |
| name resolvable | 188 (75%) |
| company reference | 229 (91%) |
| job title | 13 (5%) |
| LinkedIn | 40 (16%) |

**`strongest_connection_strength`: 169 Very weak (67%), 47 Weak (19%), 30 Good or better (12%).**

**On the order of 30 deserve a BHC_ID, not 251.** 169 distinct domains across 251 records — this is inbox exhaust, not a contact list. `glgroup.com` alone is 22 records of expert-network solicitation.

⚠ **And connection strength is not a proxy for personhood.** `foundrysupport@monotype.com`, `inquiries@navoba.org`, `staffing@hammercreative.com` and `webscustomerservice@des.wa.gov` all score Good or Very strong — because Bobby corresponds with them often, not because they are people. **A strength threshold alone will mint role addresses.**

⚠ **`company_name` is not a populated attribute on this workspace.** `company` is a reference to a companies record. Any check reading `company_name` as text gets an empty string on every record, bridged or not — which is why the name-plus-company signal agreed on zero of seven.

---

## 4. Duplicate detection — what works, measured

| Signal | Unbridged matching a bridged record |
|---|---|
| exact email | **0** |
| exact full name | **7** |
| name + company | 0 |
| LinkedIn URL | 0 |
| email local-part (loose) | 16 |

⚠ **EXACT EMAIL RETURNS ZERO BY CONSTRUCTION AND ALWAYS WILL.** `email_addresses` is `is_unique: true` on this workspace — **Attio structurally cannot put the same address on two person records.** Building duplicate detection on exact email is building on an attribute guaranteed never to fire. It would pass every test written against a fixture and find nothing forever.

**Exact full name is the only viable primary signal**, and it is the one that finds Raymond Yang. But of its seven hits, three are wrong:

- `chuck@thenewblanks.com` and `lana@thenewblanks.com` — **typo domains** (trailing `s`), misaddressed mail Attio materialised into records. Not duplicate people.
- `"Le"` matching BHC-01225 — a one-token name collision, plainly wrong.

So **exact name is a candidate generator, never a verdict.** Roughly four of seven are real. Two people can share a name, and this population contains proof.

**Email local-part** is high-recall, unacceptable precision alone — it catches `raymondy@` against a bridged `raymond*@`, and also every `info@` and `sales@` pair across unrelated domains. Useful as corroboration, never as the primary.

**LinkedIn** at 16% coverage and zero hits is not viable as a primary signal.

---

## 5. ⚠ What a merge does, and why it matters before any minting

From the live attribute definition: `bhc_contact_id` is `type: text`, **`is_unique: false`**, single-value. From Attio's own documentation: the primary record's value wins where both have one; merging produces a **new** record_id matching neither input; **both originals are marked merged and can no longer be read or written.**

| Case | Outcome |
|---|---|
| unbridged + bridged | the BHC_ID survives — the unbridged side has no value to compete |
| **two bridged records** | **the primary's BHC_ID wins and the secondary's is SILENTLY DISCARDED** — the field is non-unique, so nothing raises an error |
| either | **both input record_ids die.** Every `Master_ID.Attio_Record_ID` pointing at either goes stale the instant the merge commits |

**That second row is a live data-loss path.** One contact's identity disappears with no error, and this has already happened: `Name_Conflicts` row 3 records an ID *"merged away 2026-08-10"* leaving Master_ID pointing at a dead record while its cached `master_row` had drifted to hold a different person entirely.

**So merge only ever unbridged-into-bridged.** Never surface a merge candidate where both sides carry a BHC_ID without a loud warning naming which ID will be lost.

---

## 6. Merges are undetectable after the fact

Four record IDs probed directly:

```
deleted record        → 404 not_found
stale A3 pointer      → 404 not_found
live control          → 200
never existed         → 404 not_found
```

**No redirect, no `deleted_at`, no tombstone.** All three dead cases are byte-identical. **There is no API signal distinguishing "merged away" from "deleted" from "never existed."**

A3's existing wording — *"stale pointer — record deleted or merged in Attio"* — is not sloppiness. The ambiguity is unresolvable and **should not be tightened.**

⚠ **A3 only walks Master_ID → Attio.** It sees a pointer whose target vanished. **Merging the two Raymond Yang records tomorrow would fire nothing**, because neither is pointed at by any Master_ID row. Detection in the other direction does not exist.

---

## 7. The pass

**Extend `contacts-triage`, do not build a new pass.** `enumerateUnbridged` already defines its population as *"person records with blank `bhc_contact_id`"* — precisely these 251, already enumerated and scored, already carrying `connectionStrength`, `reason`, `status` and `skipUntil`.

**`Contacts_Triage_Queue` is the surface.** Not `Name_Conflicts` — its schema requires a BHC_ID in column D and describes name drift on one bridged contact, where an unbridged duplicate has no BHC_ID and involves two records. Not `Reconciliation_Queue` — its rows are staged writes awaiting a resolve, where a suspected duplicate is a question with three answers and no write to stage. **Not a new tab** — that forks one population across two surfaces, and Raymond Yang appearing as a duplicate card on one and a triage card on the other, resolved inconsistently, is the failure already experienced.

### Order of operations, per record

**1. SUPPRESSION FIRST — before scoring, before duplicate detection, before anything.**

Check the email and name against Master_ID rows with `Location: SUPERSEDED` and against `Contact_Exclusions`. A match means a human already decided. **Do not queue it. Do not mint. Record that it was suppressed and why, quoting the original annotation** — *"SCRAPPED 2026-08-05: Raymond Yang is TNB staff"* — so the suppression is auditable rather than silent.

⚠ This must run first. Everything downstream is wasted work on a record a human already ruled on.

**2. Duplicate candidate detection.** Exact full name against bridged records, with email local-part as corroboration. **Surface as a question, never a verdict.**

**3. Scoring and triage** for what remains — the existing path.

**4. Minting** only for records that survive all three, and only on Bobby's confirmation. **Never automatically.** See §8.

---

## 8. Minting — human-confirmed, not automatic

Bobby's stated preference was that minting *"should happen automatically."* **The investigation refutes that**, and the reason is worth stating rather than overriding quietly.

Automatic minting would have created a BHC_ID for **Raymond Yang twice** — a person deliberately scrapped 26 days earlier with the reasoning written down. It would have minted for two typo domains and 22 GLG solicitation addresses.

**The asymmetry decides it:** a wrongly-minted BHC_ID is a permanent identity-registry entry requiring manual cleanup — exactly the work done on 2026-08-05 and redone on 2026-08-30. A missed mint costs one review card.

**With suppression in place, the volume becomes tolerable.** ~30 of 251 are plausible contacts; the rest suppress, score out, or wait. That is a reviewable queue, not a flood.

Minting follows the existing contract without exception: compute max BHC_ID across Master_ID **including Attio's own `bhc_contact_id` values**, write the Master_ID stub first, stamp the Attio record, update the stub, fail loud on any step. Serially. Never parallel.

---

## 9. The Aida surface

**A duplicate card carries a direct `app.attio.com` link per record.** Attio permits no programmatic merge and merging is a judgement call regardless.

**Three actions, because a suspected duplicate is a three-answer question:** *Merge* (Bobby does it in Attio, then marks it done), *Mint as new* (they are different people), *Exclude* (neither — noise, role address, ex-staff).

⚠ **A dismissal must stick.** A card resolved and then re-raised on the next run trains the user to ignore the queue, which costs more than the queue is worth. `skipUntil` and `status` already exist for this — use them.

⚠ **After a merge, Master_ID needs reconciling and nothing will announce it.** Both input record_ids are dead; the survivor is new. **Survivor detection must be by email, never by record_id or by `bhc_contact_id`** — the recorded finding is that the ID does not reliably survive, and §5 explains the mechanism.

---

## 10. Build order

1. ✅ **DONE — 2026-09-01, commit `49cb8ef`. Suppression against SUPERSEDED and `Contact_Exclusions`.** Highest value, smallest change, and it stops the same decision being demanded weekly.

   **What it actually caught: 2 records, not the 231 headline.** The first live run suppressed 231 of 251, but the two signals are disjoint — 229 came from `Contact_Exclusions` matching that already existed before this change, and **2 from the new SUPERSEDED capability, both of them Raymond Yang**. The other 17 retired identities have no re-created Attio record today. Two is the honest number and it is the right one to have built for: it is the case §2 was written around, and the other 17 are now covered before they come back. Detail in `docs/contacts-triage-notes.md` #19.
2. ✅ **DONE — 2026-09-04. Duplicate candidate detection** — exact name, local-part corroboration, surfaced as a question. `src/passes/contacts-triage/duplicates.ts`, STEP 1c. Detection only: no write of any kind, no schema change.

   **The seven reproduced exactly** on a live dry run against 2,510 people, and a second arm the table above never measured turned up alongside them: **6 clusters of 2+ UNBRIDGED records sharing a name**, one of which is Raymond Yang — whose two records are both unbridged, so unbridged-against-bridged could never have found him. 18 candidates: 2 high, 5 medium, 11 low.

   ⚠ **The order of operations in §7 is wrong for this step, and measurably so.** Six of the seven exact-name hits are already dropped by STEP 1b and a seventh cohort by STEP 2, so detection on the post-suppression population finds **one** candidate and looks like it worked. A `Contact_Exclusions` row answers "should this become a NEW contact?" — not "is this address missing from an EXISTING contact?". Detection therefore runs over the full unbridged set and records the gate on each candidate instead of obeying it. Nothing about what gets queued, scored or excluded changed. Detail in `docs/contacts-triage-notes.md` #20.
3. **The Aida card** — three actions, per-record links, dismissals that stick.
4. **Minting on confirmation**, following the existing contract.
5. **Post-merge Master_ID reconciliation**, survivor found by email.

---

## 11. Do not

- **Do not build duplicate detection on exact email.** `is_unique: true` means it can never fire. It would pass every fixture test and find nothing forever.
- **Do not treat exact name as a verdict.** Three of seven live hits are wrong, including two typo domains.
- **Do not mint automatically.** It would have re-minted a deliberately scrapped contact twice in three days.
- **Do not use `strongest_connection_strength` alone as a mint threshold.** Four role addresses score Good or better.
- **Do not read `company_name`.** It is unpopulated on this workspace; `company` is a reference.
- **Do not tighten A3's "deleted or merged" wording.** The ambiguity is unresolvable at the API.
- **Do not surface a merge between two bridged records without naming which BHC_ID will be silently lost.**

---

## 12. Stale record to correct

`CLAUDE.md` states the contacts-triage queue is empty and its first live write failed. **A live read of `Contacts_Triage_Queue` returned a header plus at least four data rows**, and `Contact_Exclusions` likewise. A full-range read timed out, so that is a floor rather than a count. Correct it before it misleads someone.
