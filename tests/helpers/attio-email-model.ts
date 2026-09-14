/**
 * ATTIO `email_addresses` — THE CONTRACT, as MEASURED against live Attio.
 *
 * Every rule here was observed on scratch person records created for the
 * purpose on 2026-09-13 and deleted afterwards (see
 * tests/fixtures/attio-email-contract.ts for the exact sequences). Both test
 * fakes — the reconciler-fix port fake and the HTTP fake backend — hold their
 * email state in THIS model, and tests/attio-email-contract.test.ts replays
 * the measured sequences through it and through the HTTP fake.
 *
 * ⚠ WHY THIS EXISTS. The previous fake REPLACED the list on every write: PUT
 * behaviour, dressed as the PATCH the code actually sent. That made the test
 * "the address already on this record is not a conflict" pass by asserting an
 * outcome live Attio cannot produce — PATCH would have left the list unchanged
 * and the read-back would have reported qa_failed. A fake that models the
 * wrong verb makes every test green over a behaviour that cannot happen. This
 * is the fixture-vs-wire pattern, fifth instance in this repo.
 *
 * MEASURED:
 *   PATCH  new addresses go to the FRONT · an address already present is NEVER
 *          moved and never repeated · repeats are matched case-insensitively ·
 *          PATCH never removes anything.
 *   PUT    the list becomes exactly what was sent, in the order sent ·
 *          attributes not sent are left alone (the name survived).
 *   BOTH   an address held by a DIFFERENT record is rejected with HTTP 400
 *          `uniqueness_conflict` and NOTHING is stored.
 *   READ   addresses come back lowercase, in stored order.
 *
 * NOT MEASURED, and modelled conservatively — change these only on evidence:
 *   · the relative order of SEVERAL new addresses in one PATCH (modelled: the
 *     order sent, all ahead of the existing ones);
 *   · a payload that repeats an address within itself (modelled: first wins).
 */

export const ATTIO_UNIQUENESS_CONFLICT_BODY = {
  status_code: 400,
  type: 'invalid_request_error',
  code: 'uniqueness_conflict',
  message:
    'A value provided for attribute with slug "email_addresses" conflicts with one already in the system. ' +
    'This attribute has a uniqueness constraint. Please ensure all values for this attribute do not exist on another record.',
} as const;

/** Thrown by the model on a cross-record conflict; carries Attio's real message. */
export class AttioUniquenessConflict extends Error {
  readonly status = 400;
  readonly body = ATTIO_UNIQUENESS_CONFLICT_BODY;
  constructor() {
    super(`Attio 400 ${ATTIO_UNIQUENESS_CONFLICT_BODY.code}: ${ATTIO_UNIQUENESS_CONFLICT_BODY.message}`);
    this.name = 'AttioUniquenessConflict';
  }
}

const norm = (s: string): string => String(s ?? '').trim().toLowerCase();

function dedupeInOrder(emails: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of emails.map(norm)) if (e !== '' && !out.includes(e)) out.push(e);
  return out;
}

export class AttioEmailModel {
  private readonly byRecord = new Map<string, string[]>();

  constructor(initial: Readonly<Record<string, readonly string[]>> = {}) {
    for (const [id, emails] of Object.entries(initial)) this.byRecord.set(id, dedupeInOrder(emails));
  }

  /** READ: lowercase, stored order. A copy — callers cannot mutate the store. */
  read(recordId: string): string[] {
    return [...(this.byRecord.get(recordId) ?? [])];
  }

  has(recordId: string): boolean {
    return this.byRecord.has(recordId);
  }

  /** Every other record holding any of these addresses — Attio's uniqueness rule. */
  private assertNoConflict(recordId: string, emails: readonly string[]): void {
    const wanted = new Set(emails.map(norm));
    for (const [id, held] of this.byRecord) {
      if (id !== recordId && held.some((e) => wanted.has(e))) throw new AttioUniquenessConflict();
    }
  }

  /** PATCH: new addresses to the front; existing ones never moved, repeated or removed. */
  patch(recordId: string, emails: readonly string[]): void {
    this.assertNoConflict(recordId, emails); // rejected -> nothing stored
    const current = this.read(recordId);
    const added = dedupeInOrder(emails).filter((e) => !current.includes(e));
    this.byRecord.set(recordId, [...added, ...current]);
  }

  /** PUT: exactly the list sent, in the order sent. */
  put(recordId: string, emails: readonly string[]): void {
    this.assertNoConflict(recordId, emails); // rejected -> nothing stored
    this.byRecord.set(recordId, dedupeInOrder(emails));
  }
}
