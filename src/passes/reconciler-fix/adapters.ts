/**
 * Real adapters for Phases 1-3's narrow ports.
 *
 * CAPABILITY CONTAINMENT, which is the entire point of the ports existing:
 * each factory takes a full-capability client as an ARGUMENT and returns an
 * OBJECT LITERAL carrying only the port's methods. The client is captured in a
 * closure and is not reachable from the returned value - there is no `.client`,
 * no spread of the original, no prototype chain back to it. Calling
 * `Object.keys()` on either adapter returns exactly the interface's methods,
 * and a test asserts that.
 *
 * What this does NOT claim: that AttioClient becomes unusable elsewhere.
 * Anything can still `import { AttioClient }` directly, exactly as it could
 * before. The guarantee is narrower and worth stating precisely - holding an
 * adapter grants you the port's capability and nothing more, so passing one
 * into A1/I1/A3/S4 cannot smuggle in a wider surface.
 */

import { emailsOf, nameOf, textOf, type AttioClient } from '../../lib/attio.js';
import type { SheetsClient } from '../../lib/sheets.js';
import type {
  AttioIdentityWritePort, AttioPerson, AttioReadPort, AttioWritableFields, MasterSheetPort, SheetRow,
} from './ports.js';

/** Master_ID access: read any range, update one explicit range. */
export function makeMasterSheetPort(sheets: SheetsClient): MasterSheetPort {
  return {
    read: (range: string): Promise<SheetRow[]> => sheets.read(range),
    update: (range: string, values: unknown[][]): Promise<unknown> => sheets.update(range, values),
  };
}

function toPerson(recordId: string, values: Record<string, unknown>): AttioPerson {
  const jobTitle = textOf(values, 'job_title');
  const companyName = textOf(values, 'company_name');
  return {
    recordId,
    bhcContactId: textOf(values, 'bhc_contact_id') ?? '',
    name: nameOf(values) ?? '',
    ...(jobTitle !== null ? { jobTitle } : {}),
    ...(companyName !== null ? { companyName } : {}),
    emails: emailsOf(values, 'email_addresses'),
  };
}

/** Read-only Attio port, for A3 and S4 (Phase 2). No write method exists on it. */
export function makeAttioReadPort(attio: AttioClient): AttioReadPort {
  return {
    async getByRecordId(recordId: string): Promise<AttioPerson | null> {
      try {
        const rec = await attio.getPersonRecord(recordId);
        return toPerson(recordId, rec.values);
      } catch (e) {
        if (/404|not found/i.test(String(e))) return null;
        throw e;
      }
    },
    async queryByBhcContactId(bhcId: string): Promise<readonly AttioPerson[]> {
      const people = await attio.queryPeople({ bhc_contact_id: bhcId });
      return people.map((p) => toPerson(p.recordId, p.values));
    },
  };
}

/** Read access plus the one update method A1 and I1 need (Phase 3). */
export function makeAttioIdentityWritePort(attio: AttioClient): AttioIdentityWritePort {
  const read = makeAttioReadPort(attio);
  return {
    getByRecordId: read.getByRecordId,
    queryByBhcContactId: read.queryByBhcContactId,

    async queryByEmail(email: string): Promise<readonly AttioPerson[]> {
      const people = await attio.queryPeople({ email_addresses: email });
      return people.map((p) => toPerson(p.recordId, p.values));
    },

    /**
     * The single write. `values` is AttioWritableFields, which has no `name`
     * key - so this signature cannot express a name write even though the
     * underlying client could.
     */
    async updatePerson(recordId: string, values: AttioWritableFields): Promise<void> {
      await attio.updatePersonRecord(recordId, values as Record<string, unknown>);
    },
  };
}
