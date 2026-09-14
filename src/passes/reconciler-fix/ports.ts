/**
 * Reconciler Fix Phase 2 - the narrow ports the orchestration is allowed to use.
 *
 * THE ATTIO PORT HAS NO WRITE METHOD. That is the point of declaring it here
 * rather than passing the real AttioClient around: "this phase never writes to
 * Attio" is enforced by the type, not by a promise in a comment. A3 genuinely
 * READS Attio (a query by bhc_contact_id, to find out whether the record still
 * exists) and PASS 6 Step 2 reads it too - so the constraint is "no Attio
 * WRITES", never "no Attio interaction".
 */

export type SheetRow = readonly unknown[];

/** Master_ID access. Reads any range; writes one small explicit range at a time. */
export interface MasterSheetPort {
  read(range: string): Promise<SheetRow[]>;
  update(range: string, values: unknown[][]): Promise<unknown>;
}

export interface AttioPerson {
  readonly recordId: string;
  readonly bhcContactId: string;
  readonly name: string;
  // Identity fields I1 compares and writes. Optional because Phase 2's passes
  // never look at them.
  readonly jobTitle?: string;
  readonly companyName?: string;
  readonly emails?: readonly string[];
}

/** Read-only by construction - there is deliberately no update/create here. */
export interface AttioReadPort {
  /** Every live person carrying this bhc_contact_id. Zero, one, or many. */
  queryByBhcContactId(bhcId: string): Promise<readonly AttioPerson[]>;
  /** One record by id; null when it does not exist (the A3 / dead-pointer case). */
  getByRecordId(recordId: string): Promise<AttioPerson | null>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

// ─── Phase 3: the ONLY write surface this routine has into Attio ────────────

/**
 * Every attribute Reconciler Fix may write to an Attio person. Exhaustive.
 *
 * `name` IS DELIBERATELY ABSENT, and that absence is the enforcement. Name is
 * never auto-written by this routine in any pass, for any reason - name drift
 * routes to the Name_Conflicts review queue for one-at-a-time human resolution.
 * A caller cannot write a name here without first widening this type, which is
 * a visible, reviewable act rather than a typo.
 */
export type AttioWritableFields = Partial<{
  /** A1 only. */
  bhc_contact_id: string;
  /** I1: Field == Title. */
  job_title: string;
  /** I1: Field == Company. The TEXT attribute, never the `company` record-reference. */
  company_name: string;
  // ⚠ `email_addresses` IS DELIBERATELY ABSENT, for the same reason `name` is.
  // This type feeds `updatePerson`, which is a PATCH, and PATCH cannot express
  // an email repair: measured 2026-09-13, it adds new addresses to the front
  // but never moves one already present. Emails go through `replaceEmails`
  // (PUT) only, and removing the key here makes the wrong verb unwritable.
}>;

/**
 * Read access plus the single update method A1 and I1 need.
 *
 * Kept SEPARATE from AttioReadPort rather than replacing it: A3 and S4 (Phase 2)
 * take the read-only port, so their inability to write to Attio remains a
 * property of their type signature and does not quietly become a convention.
 */
export interface AttioIdentityWritePort extends AttioReadPort {
  /**
   * People carrying this email anywhere in the workspace. Needed because
   * `email_addresses` is workspace-unique: writing an address that already
   * belongs to a different person is rejected, and forcing it would merge two
   * people's contact details.
   */
  queryByEmail(email: string): Promise<readonly AttioPerson[]>;

  /** The field write (PATCH). Throws on rejection. Cannot carry emails - see AttioWritableFields. */
  updatePerson(recordId: string, values: AttioWritableFields): Promise<void>;

  /**
   * The EMAIL write: replace the whole `email_addresses` list, in order (PUT).
   * Throws on rejection, including Attio's 400 `uniqueness_conflict`.
   */
  replaceEmails(recordId: string, emails: readonly string[]): Promise<void>;
}
