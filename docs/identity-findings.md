# Identity findings

Findings about the identity registry that surfaced during other work and need their own investigation. Each is recorded **before** the work that found it continues, so it is not lost inside that work's report.

---

## BHC-02440 — a second ID in circulation for Andrew Kobliska (BHC-01541)

**Recorded 2026-09-13**, during the Tasks_Log column P backfill dry run. **Status: open — not investigated, not repaired.**

### How it surfaced

The backfill's BHC_ID gate requires the Attio task's linked person to carry the same `bhc_contact_id` as the Tasks_Log row's `Contact_ID`. Row 225 (`TASK-1781903681373`, "Andrew Kobliska") failed it: the Attio task links the person whose `bhc_contact_id` is **BHC-01541**, while the row says **BHC-02440**. The row was removed from the backfill.

### What was measured, read-only, 2026-09-13

**Master_ID holds no row whose BHC_ID is BHC-02440.** For Andrew Kobliska it holds:

- **BHC-01541** · Location `BOTH` · Google_Row 388 · Attio `97141475-87ab-4513-95ad-adcb2bf68764`
- two rows with a **blank BHC_ID**, Location `SUPERSEDED`, whose notes begin:
  - "ORPHAN CLEARED: Andrew Kobliska is BHC-01541 at Master_ID row 1572 (Attio 97141475). This was a duplicate row from prior…"
  - "ORPHAN CLEARED: duplicate of BHC-01541 (Andrew Kobliska). Minted by HF_Sync HF-SYNC-1783383971391 — Segment_Sync dedups…"

  (Notes read truncated at 120 characters; the full text was not captured.)

**BHC-02440 is still referenced outside Master_ID**, all dated June 2026:

| Tab | Row | ID | Date | Contact_Name | Detail |
|---|---|---|---|---|---|
| Tasks_Log | 194 | TASK-FATHOM-1780671020074-0 | 2026-06-05 | AK | Closed · no activity ID |
| Tasks_Log | 195 | TASK-FATHOM-1780671020074-1 | 2026-06-05 | AK | Closed · no activity ID |
| Tasks_Log | 196 | TASK-FATHOM-1780671020075-2 | 2026-06-05 | AK | Closed · no activity ID |
| Tasks_Log | 225 | TASK-1781903681373 | 2026-06-19 | Andrew Kobliska | Cancelled · ACT-1781903214570-rxjwm |
| Activity_Log | 722 | ACT-1780671024627-vs7v | 2026-06-05 | AK | src Fathom_Zap |
| Activity_Log | 731 | ACT-1781903214068-ro337 | 2026-06-19 | Andrew Kobliska | src late_edition |
| Activity_Log | 737 | ACT-1781903214570-rxjwm | 2026-06-19 | Andrew Kobliska | src late_edition · **col T = Attio task `ac8ebd2b-3a3f-4e08-a1c2-8e66a39bb13d`** |

For comparison, BHC-01541 appears on 19 Tasks_Log rows and 70 Activity_Log rows.

### Why it is a duplicate identity, not a typo

Two different IDs are carried by records for one person, over at least two weeks and two capture sources (Fathom_Zap and late_edition). The retired ID's registry row has been cleared, but **every downstream reference to it was left behind** — so those rows point at an identity the registry no longer holds, and anything keying on `Contact_ID` (Day Book, PASS 2.5 clustering, task-to-contact joins) splits Kobliska's history in two.

### Open questions for the investigation

1. When was BHC-02440 minted, by which path, and was it one of the SUPERSEDED rows above before its ID was blanked?
2. Is Activity_Log row 737's Attio task `ac8ebd2b` linked to BHC-01541's Attio person? It did not enter the backfill set: its activity has no single matching Tasks_Log row.
3. Should the seven referencing rows be re-pointed to BHC-01541? That is a write to shared history and needs its own spec — **nothing in the backfill touched them.**
4. Are there other cleared duplicates whose downstream references were left behind? The ORPHAN CLEARED notes suggest the clearing pass edits Master_ID only.
