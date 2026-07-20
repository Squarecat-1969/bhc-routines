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
import { requestJson, sleep, withRetry, type RetryOptions } from './http.js';

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
 * The cadence "last touch" reads Attio's built-in `last_interaction` attribute,
 * an "interaction"-typed value whose payload nests the timestamp under
 * `interacted_at` (confirmed via `--dump-shapes` on a real record). A plain
 * date/timestamp `value` shape is still accepted for other date slugs.
 * See docs/pass4-notes.md #4.
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

/**
 * Email-address attribute → the primary address. `email_addresses` is an
 * array-typed attribute — the first entry is the primary one (confirmed via
 * `--dump-shapes`: multiple entries appear in creation order, primary first).
 * Spec 4.5b: "ATTIO-only → Attio email_addresses primary."
 */
export function emailOf(values: AttioValues | undefined, slug: string): string | null {
  const v = firstValue(values, slug);
  if (!v) return null;
  if (typeof v['email_address'] === 'string') return v['email_address'];
  if (typeof v['value'] === 'string') return v['value'];
  return null;
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
   * Search people by email. Spec 2b's resolution cascade: "Miss → Attio by
   * email → record_id + bhc_contact_id", filter shape
   * `{"email_addresses": {"$contains": "<email>"}}`.
   *
   * DEVIATION FROM SPEC: the spec's filter syntax is written for the Attio MCP
   * connector's query tool. This uses the same shape against Attio's REST
   * `records/query` endpoint (same reasoning as `listEntries` — no MCP host in
   * GitHub Actions). NOT yet verified against a live query — unlike the
   * per-record GET shapes (confirmed via --dump-shapes), a query-with-filter
   * call hasn't been checked. See docs/pass2-notes.md.
   *
   * Returns [] on zero matches (a miss, not an error) or if the response shape
   * doesn't parse as expected — never throws for "no results," so callers can
   * treat an empty array as "cascade to the next resolution step."
   */
  async searchPeopleByEmail(email: string): Promise<AttioPersonRecord[]> {
    const res = await this.request<{ data?: unknown[] }>('/objects/people/records/query', {
      method: 'POST',
      body: JSON.stringify({ filter: { email_addresses: { $contains: email } } }),
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    const out: AttioPersonRecord[] = [];
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const id = row['id'];
      const recordId =
        id && typeof id === 'object' && typeof (id as Record<string, unknown>)['record_id'] === 'string'
          ? ((id as Record<string, unknown>)['record_id'] as string)
          : null;
      if (!recordId) continue;
      out.push({ recordId, values: (row['values'] as AttioValues) ?? {} });
    }
    return out;
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

  /**
   * Create an Attio task linked to a person record. Built for Part D's STEP
   * 4d ("create Attio task: content, format: plaintext, linked_records:
   * [record_id], assignees: [ATTIO_BOBBY_MEMBER]").
   *
   * UNVERIFIED — this is the one genuinely new capability in this file, and
   * unlike everything else here (read/list/search/update-record, all
   * cross-checked against bhc-aida's own live-working code), no task
   * *creation* call exists anywhere in either repo to confirm this shape
   * against. bhc-aida's tasks/route.ts and current-state/route.ts both READ
   * tasks (RawAttioTask: linked_records as {target_object, target_record_id}[],
   * assignees as {referenced_actor_id}[]) and PATCH is_completed — the shape
   * below mirrors that confirmed read shape for the create body, on the
   * reasonable assumption Attio's create/read shapes match, but that's an
   * assumption, not a live-checked fact. Needs a real --dump-shapes-style
   * dry-run against one real task before this is trusted in production —
   * same discipline PASS 4's own field-slug verification used before going
   * live. Do not remove this comment until that verification has happened.
   */
  async createTask(params: {
    readonly content: string;
    readonly deadlineAt: string | null; // ISO date, or null for no deadline
    readonly linkedRecordId: string;
    readonly linkedRecordObject?: string; // defaults to 'people'
    readonly assigneeId: string;
  }): Promise<{ taskId: string }> {
    const body = {
      content: params.content,
      format: 'plaintext',
      deadline_at: params.deadlineAt,
      is_completed: false,
      linked_records: [
        { target_object: params.linkedRecordObject ?? 'people', target_record_id: params.linkedRecordId },
      ],
      assignees: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: params.assigneeId }],
    };
    const res = await this.request<{ data?: { id?: { task_id?: string } } }>('/tasks', {
      method: 'POST',
      body: JSON.stringify({ data: body }),
    });
    const taskId = res.data?.id?.task_id;
    if (!taskId) throw new Error('createTask: response had no task_id — cannot confirm the task was created');
    return { taskId };
  }
}

export interface FetchBatchedOptions {
  readonly batchSize?: number;
  readonly pauseMs?: number;
  readonly onProgress?: (done: number, total: number) => void;
  readonly onFailure?: (recordId: string, error: unknown) => void;
}

/**
 * Fetch many person records by ID, batched and paced.
 *
 * DEVIATION FROM SPEC: the spec says "Attio MCP connector's get-records-by-ids"
 * — a true bulk endpoint. GitHub Actions has no MCP host (same reason PASS 4 uses
 * REST at all), and Attio's REST API has no bulk-by-ID endpoint, only per-record
 * GET. This does the same *pattern* the spec asks for — batched, paced, retried,
 * a failure never aborts the batch — just as N parallel single-record GETs per
 * batch instead of one bulk call. PASS 4 already established this exact pattern
 * at ~44 records; this is the same helper, extracted so PASS 4.5 doesn't
 * reimplement it at ~2,213 records. See docs/pass4_5-notes.md.
 */
export async function fetchPersonRecordsBatched(
  attio: AttioClient,
  ids: readonly string[],
  opts: FetchBatchedOptions = {},
): Promise<Map<string, AttioPersonRecord | null>> {
  const batchSize = opts.batchSize ?? 10;
  const pauseMs = opts.pauseMs ?? 2_000;
  const out = new Map<string, AttioPersonRecord | null>();

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((id) => attio.getPersonRecord(id)));

    settled.forEach((res, j) => {
      const id = batch[j]!;
      if (res.status === 'fulfilled') {
        out.set(id, res.value);
      } else {
        out.set(id, null);
        opts.onFailure?.(id, res.reason);
      }
    });

    const done = Math.min(i + batchSize, ids.length);
    opts.onProgress?.(done, ids.length);
    if (done < ids.length) await sleep(pauseMs);
  }

  return out;
}
