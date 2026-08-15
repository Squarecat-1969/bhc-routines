/**
 * Google Sheets access via the Aida proxy (https://aida.hougham.us/api/brain/sheets).
 * The service-account key lives in Vercel; we only ever hold BRAIN_API_TOKEN.
 *
 * PASS 4 is read-only against Sheets. `update`/`append` arrive here with PASS 4.5,
 * the first pass that writes to Google. Body shape (action: 'read'|'update'|'append',
 * range, values) matches the `sheets()` helper already used by every prompt-spec
 * routine — see routines/BHC_Late_Edition.md's Authentication section.
 */

import { requestJson, withRetry, type RetryOptions } from './http.js';

export type SheetRow = readonly unknown[];

export interface SheetsClientOptions {
  readonly token: string;
  readonly url: string;
  readonly onRetry?: RetryOptions['onRetry'];
}

export class SheetsClient {
  constructor(private readonly opts: SheetsClientOptions) {}

  private post<T = unknown>(body: Record<string, unknown>, label: string): Promise<T> {
    return withRetry(
      () =>
        requestJson<T>(this.opts.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      { label, ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}) },
    );
  }

  /**
   * Read an A1 range. Returns [] for an empty range.
   *
   * A 401/5xx here is fatal per the spec ("If the Sheets proxy is unreachable or
   * returns 401/5xx, stop the run... Do not half-process") — we let it throw and
   * the caller decides. Retries only cover transient classes; a 401 throws at once.
   */
  async read(range: string, renderOption = 'UNFORMATTED_VALUE'): Promise<SheetRow[]> {
    const res = await this.post<{ values?: unknown[][] }>(
      { action: 'read', range, valueRenderOption: renderOption },
      `sheets:read ${range}`,
    );
    return Array.isArray(res.values) ? res.values : [];
  }

  /**
   * Overwrite the given A1 range with `values`, top-left anchored. Same semantics
   * as the Sheets API's `values.update` — cells outside the written block are
   * untouched, so blanking trailing rows means writing empty strings into them
   * explicitly (spec 4.5e), not a separate clear call.
   */
  async update(range: string, values: readonly SheetRow[]): Promise<void> {
    await this.post({ action: 'update', range, values }, `sheets:update ${range}`);
  }

  /**
   * Append rows after the last row of data in the given range/sheet.
   *
   * Returns what Google reports actually landed, rather than nothing. A
   * caller that only knows "the call didn't throw" is asserting intent, not
   * outcome — the same class of defect as Part D's unconditional activity
   * counter. On 2026-08-14 Activity_Log appends returned successfully and
   * wrote nothing while Contact_History received all seven rows from the same
   * client in the same run; that is still unexplained, and this return value
   * is the instrumentation that will identify it.
   *
   * `updatedRows` comes from the real API's `updates.updatedRows`. Absent or
   * malformed responses report 0 — an unverifiable append is treated as one
   * that did not land, never as one that did.
   */
  async append(range: string, values: readonly SheetRow[]): Promise<{ updatedRows: number }> {
    const res = await this.post<{ updates?: { updatedRows?: number } }>(
      { action: 'append', range, values },
      `sheets:append ${range}`,
    );
    return { updatedRows: res.updates?.updatedRows ?? 0 };
  }
}

/** Read a cell from a row, tolerating short rows (Sheets truncates trailing blanks). */
export function cell(row: SheetRow | undefined, index: number): string {
  const v = row?.[index];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
