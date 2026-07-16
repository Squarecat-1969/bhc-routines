/**
 * Attio REST client.
 *
 * The spec says "Attio MCP connector", but a GitHub Actions run has no MCP
 * host — so this talks to the Attio REST API with ATTIO_API_KEY instead. The
 * data model is the same; only the transport differs.
 *
 * Attio returns every attribute as an array of value objects whose shape varies
 * by attribute type. The extractors below are deliberately tolerant: they try
 * the documented shape, then known alternates, then give up and return null
 * rather than guessing. `--dump-shapes` on the CLI prints one raw record so the
 * slugs and shapes can be verified against the live workspace before any write.
 */

import { parseFlexibleDate, type CivilDate } from './dates.js';
import { requestJson, withRetry, type RetryOptions } from './http.js';

export type AttioValues = Record<string, unknown>;

export interface AttioPersonRecord {
  readonly recordId: string;
  readonly values: AttioValues;
}

export interface AttioPipelineEntry {
  readonly entryId: string | null;
  readonly recordId: string;
  readonly entryValues: AttioValues;
}

function firstValue(values: AttioValues | undefined, slug: string): Record<string, unknown> | undefined {
  const arr = values?.[slug];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const v = arr[0];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** Select attribute → option title. Spec: `entry_values.<slug>[0].option.title`. */
export function selectTitleOf(values: AttioValues | undefined, slug: string): string | null {
  const v = firstValue(values, slug);
  if (!v) return null;
  const option = v['option'];
  if (option && typeof option === 'object' && typeof (option as Record<string, unknown>)['title'] === 'string') {
    return (option as Record<string, unknown>)['title'] as string;
  }
  if (typeof v['value'] === 'string') return v['value'];
  return null;
}

/** Text / number attribute → primitive value. */
export function textOf(values: AttioValues | undefined, slug: string): string | null {
  const v = firstValue(values, slug);
  if (!v) return null;
  const raw = v['value'];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return null;
}

/**
 * Date / timestamp attribute → CivilDate.
 *
 * ASSUMPTION: `last_interaction_at` is read as a plain date/timestamp attribute
 * (`value`). Attio also ships a built-in "interaction"-typed attribute whose
 * payload nests the timestamp under `interacted_at`, so both are accepted.
 * Verify against a real dry run before trusting either. See docs/pass4-notes.md #4.
 */
export function dateOf(values: AttioValues | undefined, slug: string): CivilDate | null {
  const v = firstValue(values, slug);
  if (!v) return null;
  const raw = v['value'] ?? v['interacted_at'] ?? v['date'] ?? null;
  return parseFlexibleDate(raw);
}

/** Personal-name attribute → full name. */
export function nameOf(values: AttioValues | undefined, slug = 'name'): string | null {
  const v = firstValue(values, slug);
  if (!v) return null;
  if (typeof v['full_name'] === 'string') return v['full_name'];
  if (typeof v['value'] === 'string') return v['value'];
  const first = typeof v['first_name'] === 'string' ? v['first_name'] : '';
  const last = typeof v['last_name'] === 'string' ? v['last_name'] : '';
  const joined = `${first} ${last}`.trim();
  return joined === '' ? null : joined;
}

export interface AttioClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly onRetry?: RetryOptions['onRetry'];
}

export class AttioClient {
  constructor(private readonly opts: AttioClientOptions) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
    return withRetry(() => requestJson<T>(url, { ...init, headers: this.headers }), {
      label: path,
      ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}),
    });
  }

  /** All entries in a list, paginated. Spec 4a expects ~44 for the pipeline list. */
  async listEntries(listId: string, pageSize = 50): Promise<AttioPipelineEntry[]> {
    const out: AttioPipelineEntry[] = [];
    let offset = 0;

    for (;;) {
      const res = await this.request<{ data?: unknown[] }>(`/lists/${listId}/entries/query`, {
        method: 'POST',
        body: JSON.stringify({ limit: pageSize, offset }),
      });
      const page = Array.isArray(res.data) ? res.data : [];
      for (const raw of page) {
        const entry = raw as Record<string, unknown>;
        const recordId = entry['parent_record_id'];
        if (typeof recordId !== 'string' || recordId === '') continue;
        const id = entry['id'];
        const entryId =
          id && typeof id === 'object' && typeof (id as Record<string, unknown>)['entry_id'] === 'string'
            ? ((id as Record<string, unknown>)['entry_id'] as string)
            : null;
        out.push({
          entryId,
          recordId,
          entryValues: (entry['entry_values'] as AttioValues) ?? {},
        });
      }
      if (page.length < pageSize) break;
      offset += page.length;
    }

    return out;
  }

  async getPersonRecord(recordId: string): Promise<AttioPersonRecord> {
    const res = await this.request<{ data?: Record<string, unknown> }>(
      `/objects/people/records/${recordId}`,
      { method: 'GET' },
    );
    return { recordId, values: (res.data?.['values'] as AttioValues) ?? {} };
  }

  /**
   * PATCH a person record. Only ever called with the three cadence attributes
   * (spec Non-negotiable #12 scopes PASS 4's writes to exactly those).
   */
  async updatePersonRecord(recordId: string, values: Record<string, unknown>): Promise<void> {
    await this.request(`/objects/people/records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { values } }),
    });
  }
}
