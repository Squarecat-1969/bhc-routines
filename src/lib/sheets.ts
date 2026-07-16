/**
 * Google Sheets access via the Aida proxy (https://aida.hougham.us/api/brain/sheets).
 * The service-account key lives in Vercel; we only ever hold BRAIN_API_TOKEN.
 *
 * PASS 4 is read-only against Sheets — it reads Master_ID and Contacts to build
 * the tier index and the identity gate, and writes nothing. `update`/`append`
 * are intentionally not implemented here yet; they arrive with the first pass
 * that actually needs them (PASS 4.5).
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

  /**
   * Read an A1 range. Returns [] for an empty range.
   *
   * A 401/5xx here is fatal per the spec ("If the Sheets proxy is unreachable or
   * returns 401/5xx, stop the run... Do not half-process") — we let it throw and
   * the caller decides. Retries only cover transient classes; a 401 throws at once.
   */
  async read(range: string, renderOption = 'UNFORMATTED_VALUE'): Promise<SheetRow[]> {
    const res = await withRetry(
      () =>
        requestJson<{ values?: unknown[][] }>(this.opts.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'read', range, valueRenderOption: renderOption }),
        }),
      { label: `sheets:read ${range}`, ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}) },
    );
    return Array.isArray(res.values) ? res.values : [];
  }
}

/** Read a cell from a row, tolerating short rows (Sheets truncates trailing blanks). */
export function cell(row: SheetRow | undefined, index: number): string {
  const v = row?.[index];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
