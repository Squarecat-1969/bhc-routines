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
