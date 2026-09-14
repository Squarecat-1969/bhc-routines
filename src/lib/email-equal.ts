/**
 * Email address equality — lowercase and trim, NOTHING ELSE.
 *
 * ⚠ DELIBERATELY NOT `fieldEqual`. That helper normalises NAMES and titles: it
 * turns every punctuation mark and symbol into a space. Right for
 * "Ada  Lovelace" vs "ada lovelace"; wrong for an address, where
 * `john.smith@x.com` and `john-smith@x.com` are different mailboxes that
 * `fieldEqual` reads as the same "john smith x com".
 *
 * Reconciler (the detector) and Reconciler Fix (the repair) use this one
 * function for every email comparison, so the two sides of the chain cannot
 * disagree about whether two addresses are the same.
 */
export function emailEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseEmail(a);
  return x !== '' && x === normaliseEmail(b);
}

export function normaliseEmail(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase();
}
