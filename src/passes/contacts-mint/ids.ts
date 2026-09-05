/**
 * STEP 4a — CLAUSE 1 OF THE MINTING CONTRACT.
 *
 *   "Compute the maximum BHC_ID across Master_ID INCLUDING Attio's own
 *    bhc_contact_id values — never Master_ID alone."
 *
 * ⚠ THIS IS THE CLAUSE THAT GETS SKIPPED, and it is skipped in live code right
 * now. `bhc-aida`'s commit route allocates with:
 *
 *     const data = await proxy('read', 'Master_ID!A2:A');   // and nothing else
 *
 * Master_ID alone. Three call sites use it. Measured 2026-09-05 the two systems
 * happen to agree (both max BHC-02530), so it currently issues the right
 * number — which is exactly why a missing guard here survives review. It is not
 * wrong today; it is unguarded, and the day Attio leads is the day it re-issues
 * an ID that already exists on a person.
 *
 * THE SHAPE OF THE GUARD IS THE POINT. `computeNextBhcId` takes BOTH id lists
 * as required arguments and has no default for either. There is no call that
 * consults one system, because there is no signature that permits it. A guard
 * you can satisfy by passing an empty array is a guard; a guard you cannot omit
 * an argument to is a contract.
 *
 * Attio can genuinely lead. 255 of 2,510 person records carry no
 * bhc_contact_id, and every one of them is a record Attio's own email sync
 * created after the last mint — so the two sequences drift apart in normal
 * operation, not only under failure.
 */

/** `BHC-02530` → 2530. Anything else → null; never a silent 0. */
const BHC_ID_RE = /^BHC-0*(\d+)$/i;

export function parseBhcId(value: string | null | undefined): number | null {
  const m = BHC_ID_RE.exec(String(value ?? '').trim());
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** 2531 → "BHC-02531". Five digits, matching every ID in the live sequence. */
export function formatBhcId(n: number): string {
  return `BHC-${String(n).padStart(5, '0')}`;
}

export type MaxHolder = 'master-id' | 'attio' | 'both' | 'neither';

export interface NextBhcId {
  /** The allocation. */
  readonly nextId: string;
  readonly nextNumber: number;
  /** The maximum across BOTH systems — what nextId is derived from. */
  readonly max: number;
  /** Which system holds it. `both` means they agree, `neither` means no IDs. */
  readonly holder: MaxHolder;
  readonly masterMax: number | null;
  readonly attioMax: number | null;
  /**
   * What Master_ID alone would have produced. Equal to nextId whenever the
   * systems agree — which is the normal case, and the reason this is reported
   * rather than assumed. When it differs, it is the collision clause 1 exists
   * to prevent, and the caller must say so out loud.
   */
  readonly masterOnlyWouldBe: string;
  readonly wouldHaveCollided: boolean;
  /** Values that parsed as neither an ID nor blank, reported never dropped. */
  readonly malformed: readonly string[];
}

/**
 * The next BHC_ID, from both sequences.
 *
 * ⚠ BOTH ARGUMENTS ARE REQUIRED AND NEITHER HAS A DEFAULT. Removing Attio from
 * the computation is not a one-character edit here; it is a signature change
 * that every call site and every test refuses. That is deliberate — see the
 * header.
 *
 * Malformed values are collected, not skipped silently and not thrown on: a
 * single typo in one Master_ID cell must not be able to stop every mint, but it
 * must also never vanish. The caller decides.
 */
export function computeNextBhcId(
  masterIdValues: readonly (string | null | undefined)[],
  attioBhcContactIds: readonly (string | null | undefined)[],
): NextBhcId {
  const malformed: string[] = [];

  const parseAll = (values: readonly (string | null | undefined)[]): number[] => {
    const out: number[] = [];
    for (const v of values) {
      const raw = String(v ?? '').trim();
      if (raw === '') continue;
      const n = parseBhcId(raw);
      if (n === null) {
        malformed.push(raw);
        continue;
      }
      out.push(n);
    }
    return out;
  };

  const masterNums = parseAll(masterIdValues);
  const attioNums = parseAll(attioBhcContactIds);

  const masterMax = masterNums.length > 0 ? Math.max(...masterNums) : null;
  const attioMax = attioNums.length > 0 ? Math.max(...attioNums) : null;

  const max = Math.max(masterMax ?? 0, attioMax ?? 0);

  const holder: MaxHolder =
    masterMax === null && attioMax === null ? 'neither'
      : masterMax !== null && attioMax !== null && masterMax === attioMax ? 'both'
        : (attioMax ?? -1) > (masterMax ?? -1) ? 'attio'
          : 'master-id';

  const masterOnlyWouldBe = formatBhcId((masterMax ?? 0) + 1);
  const nextNumber = max + 1;

  return {
    nextId: formatBhcId(nextNumber),
    nextNumber,
    max,
    holder,
    masterMax,
    attioMax,
    masterOnlyWouldBe,
    // True exactly when Attio holds an ID Master_ID has never seen: the
    // Master_ID-only allocation would land on a number already in use.
    wouldHaveCollided: masterOnlyWouldBe !== formatBhcId(nextNumber),
    malformed,
  };
}

/**
 * The IDs a SERIAL batch would allocate.
 *
 *   "Mint SERIALLY: read max, write, increment. Never parallel-mint."
 *
 * ⚠ THIS IS A PROJECTION, NOT A RESERVATION. It answers "if these n mints ran
 * one after another, which IDs would they get" — which is what a dry run has to
 * show. A live batch must still re-read the max before each individual mint,
 * because Attio's sync can stamp a record between two of them. Handing this
 * array to a live executor and writing all of it without re-reading is the
 * parallel mint the contract forbids, wearing a serial mint's clothes.
 */
export function projectSerialIds(start: NextBhcId, count: number): readonly string[] {
  if (count < 0) throw new Error(`projectSerialIds: count must be >= 0, got ${count}`);
  return Array.from({ length: count }, (_, i) => formatBhcId(start.nextNumber + i));
}
