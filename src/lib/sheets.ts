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
   * `updatedRows` comes from the real API's `updates.updatedRows`, and
   * defaults to 0 — an unverifiable append is treated as one that did not
   * land, never as one that did.
   *
   * The two booleans keep THREE facts apart that a bare 0 collapses into one,
   * because each points at a different layer:
   *
   *   updates + updatedRows: 0  Google itself declined to write. A Sheets
   *                             fault.
   *   no updates block          The response never carried the field. A
   *                             transport or proxy fault.
   *   updates, no updatedRows   Google always emits updatedRows alongside
   *                             updates, so this shape means something
   *                             between here and Google RESHAPED the
   *                             response. A proxy-layer fault specifically —
   *                             and reporting it as a Sheets refusal would
   *                             aim diagnosis at the wrong layer, which is
   *                             the failure this whole distinction exists to
   *                             prevent.
   *
   * On 2026-08-14 we could not tell any of them apart.
   */
  /**
   * Many scattered single-cell writes in ONE request.
   *
   * Google's quota is counted per REQUEST, not per cell — 60 writes/minute per
   * user, and independently 60 reads/minute. Issuing one `update` per cell is
   * what exhausted both on 2026-08-20: 291 corrections at two calls each ran
   * ~220 requests/minute against a 60 ceiling, and the retry policy could not
   * help because the whole minute's quota was already gone.
   *
   * Mirrors the `batchUpdate` action the Sheets proxy already exposes — the same
   * one BHC-Aida's commit route uses to fold 78 scattered status cells into a
   * single request. Same scope as `update`: these ranges, these values, nothing
   * wider.
   */
  async batchUpdate(data: readonly { range: string; values: readonly SheetRow[] }[]): Promise<void> {
    if (data.length === 0) return;
    await this.post({ action: 'batchUpdate', data }, `sheets:batchUpdate ${data.length} range(s)`);
  }

  async append(
    range: string,
    values: readonly SheetRow[],
  ): Promise<{ updatedRows: number; updatesBlockPresent: boolean; updatedRowsFieldPresent: boolean }> {
    const res = await this.post<{ updates?: { updatedRows?: number } }>(
      { action: 'append', range, values },
      `sheets:append ${range}`,
    );
    const updates = res.updates;
    return {
      updatedRows: updates?.updatedRows ?? 0,
      updatesBlockPresent: updates !== undefined && updates !== null,
      updatedRowsFieldPresent: typeof updates?.updatedRows === 'number',
    };
  }
}

/** Read a cell from a row, tolerating short rows (Sheets truncates trailing blanks). */
export function cell(row: SheetRow | undefined, index: number): string {
  const v = row?.[index];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
