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

  /** Append rows after the last row of data in the given range/sheet. */
  async append(range: string, values: readonly SheetRow[]): Promise<void> {
    await this.post({ action: 'append', range, values }, `sheets:append ${range}`);
  }
}

/** Read a cell from a row, tolerating short rows (Sheets truncates trailing blanks). */
export function cell(row: SheetRow | undefined, index: number): string {
  const v = row?.[index];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
