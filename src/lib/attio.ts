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
  /**
   * Record-level creation timestamp (ISO-8601), read from the payload's
   * top-level `created_at` with the `values.created_at` attribute as fallback.
   * Optional because the two pre-existing consumers (PASS 4, PASS 4.5) never
   * asked for it; Contacts Triage's compromise-cohort predicate is defined
   * entirely in terms of it, so for that routine an absent value is a fact
   * worth reporting rather than a default worth inventing.
   */
  readonly createdAt?: string | null;
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

/**
 * Record-level `created_at`, preferring the payload's own top-level field and
 * falling back to the `created_at` attribute inside `values`. Returns null
 * rather than a guess — a routine that keys an exclusion off creation time
 * needs to be able to tell "created outside the window" from "no idea when".
 */
function readCreatedAt(row: Record<string, unknown> | undefined): string | null {
  if (!row) return null;
  const top = row['created_at'];
  if (typeof top === 'string' && top !== '') return top;
  const fromValues = textOf(row['values'] as AttioValues | undefined, 'created_at');
  return fromValues !== null && fromValues !== '' ? fromValues : null;
}

/** One row of a `records/query` response -> AttioPersonRecord, or null if it has no usable record_id. */
function parsePersonRow(raw: unknown): AttioPersonRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = row['id'];
  const recordId =
    id && typeof id === 'object' && typeof (id as Record<string, unknown>)['record_id'] === 'string'
      ? ((id as Record<string, unknown>)['record_id'] as string)
      : null;
  if (!recordId) return null;
  return { recordId, values: (row['values'] as AttioValues) ?? {}, createdAt: readCreatedAt(row) };
}

/**
 * Record-reference attribute -> the referenced record's id.
 *
 * Attio's people carry `company` as a reference even where the denormalized
 * `company_name` text is empty (measured live: 81/102 vs 0/102 across the
 * Contacts Triage candidate set), so reading the reference is the only way to
 * put a company on the card.
 */
export function referenceIdOf(values: AttioValues | undefined, slug: string): string | null {
  const v = firstValue(values, slug);
  if (!v) return null;
  const direct = v['target_record_id'];
  if (typeof direct === 'string' && direct !== '') return direct;
  const nested = v['target_record'];
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>)['record_id'];
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

/**
 * EVERY address on an email-address attribute, lowercased, in payload order
 * (primary first). `emailOf` returns only the primary, which is the right
 * answer for display; deciding "did this contact reply" needs all of them,
 * because people write from their second address constantly.
 */
export function emailsOf(values: AttioValues | undefined, slug: string): string[] {
  const arr = values?.[slug];
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      if (entry.includes('@')) out.push(entry.trim().toLowerCase());
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const raw = obj['email_address'] ?? obj['value'];
    if (typeof raw === 'string' && raw.includes('@')) out.push(raw.trim().toLowerCase());
  }
  return [...new Set(out)];
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

  /**
   * Escape hatch for endpoints that don't belong on this class.
   *
   * `lib/attio-emails.ts` needs the same auth/retry/base-URL behaviour for an
   * endpoint whose shape is still unverified; giving it this rather than a
   * second half-configured client keeps exactly one place where an Attio
   * request is built. Path is appended to the base URL as-is.
   */
  requestRaw<T>(path: string, init: RequestInit): Promise<T> {
    return this.request<T>(path, init);
  }

  async getPersonRecord(recordId: string): Promise<AttioPersonRecord> {
    const res = await this.request<{ data?: Record<string, unknown> }>(
      `/objects/people/records/${recordId}`,
      { method: 'GET' },
    );
    return {
      recordId,
      values: (res.data?.['values'] as AttioValues) ?? {},
      createdAt: readCreatedAt(res.data),
    };
  }

  /**
   * Every person record in the workspace, via offset pagination over
   * `records/query`.
   *
   * Contacts Triage STEP 1 wants "people with no bhc_contact_id" and a count
   * it can trust. It gets both from one full walk plus a client-side split,
   * rather than a server-side emptiness filter: the walk is the ground truth,
   * and a separate filtered query is then free to act as an *independent*
   * cross-check of it (see `countPeopleMatching`). Filtering server-side would
   * make the check circular.
   *
   * Offset pagination with no explicit sort can in principle repeat or skip a
   * record if the underlying order shifts mid-walk, so the caller is handed
   * `duplicateIds` — a page-boundary repeat is the visible symptom of exactly
   * that, and Contacts Triage treats it as a reason to stop rather than a
   * curiosity. `sorts` is deliberately not sent: an unsupported sort
   * expression would 400 the entire enumeration, which is a worse failure
   * than the one it would be guarding against.
   */
  async listAllPeople(
    opts: {
      readonly pageSize?: number;
      readonly maxPages?: number;
      readonly onPage?: (fetched: number) => void;
    } = {},
  ): Promise<{ people: AttioPersonRecord[]; duplicateIds: string[]; pages: number }> {
    const pageSize = opts.pageSize ?? 500;
    const maxPages = opts.maxPages ?? 200;
    const people: AttioPersonRecord[] = [];
    const duplicateIds: string[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let pages = 0;

    for (;;) {
      if (pages >= maxPages) {
        throw new Error(
          `listAllPeople: hit the ${maxPages}-page backstop at offset ${offset} — pagination is not terminating`,
        );
      }
      const res = await this.request<{ data?: unknown[] }>('/objects/people/records/query', {
        method: 'POST',
        body: JSON.stringify({ limit: pageSize, offset }),
      });
      const page = Array.isArray(res.data) ? res.data : [];
      pages += 1;

      for (const raw of page) {
        const parsed = parsePersonRow(raw);
        if (!parsed) continue;
        if (seen.has(parsed.recordId)) {
          duplicateIds.push(parsed.recordId);
          continue;
        }
        seen.add(parsed.recordId);
        people.push(parsed);
      }

      opts.onPage?.(people.length);
      if (page.length < pageSize) break;
      offset += page.length;
    }

    return { people, duplicateIds, pages };
  }

  /**
   * Company record_id -> company name, for resolving people's `company`
   * references. One paginated walk of the companies object rather than a
   * lookup per person: there are far fewer companies than people, and the map
   * is reused across the whole run.
   */
  async listCompanyNames(pageSize = 500, maxPages = 200): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let offset = 0;
    let pages = 0;

    for (;;) {
      if (pages >= maxPages) throw new Error(`listCompanyNames: hit the ${maxPages}-page backstop`);
      const res = await this.request<{ data?: unknown[] }>('/objects/companies/records/query', {
        method: 'POST',
        body: JSON.stringify({ limit: pageSize, offset }),
      });
      const page = Array.isArray(res.data) ? res.data : [];
      pages += 1;
      for (const raw of page) {
        const parsed = parsePersonRow(raw); // same id/values envelope
        if (!parsed) continue;
        const name = textOf(parsed.values, 'name');
        if (name !== null && name !== '') out.set(parsed.recordId, name);
      }
      if (page.length < pageSize) break;
      offset += page.length;
    }

    return out;
  }

  /**
   * Count person records matching an arbitrary Attio filter, by paginating it.
   *
   * UNVERIFIED FILTER SYNTAX. Contacts Triage uses this only as a cross-check
   * of an enumeration it has already completed by other means, and treats a
   * *failure to run the check* differently from a *check that disagrees* — so
   * an unsupported operator here degrades to a loud warning rather than
   * silently corrupting a count. Same caveat as `searchPeopleByEmail`.
   */
  async countPeopleMatching(
    filter: Record<string, unknown>,
    opts: { readonly pageSize?: number; readonly maxPages?: number } = {},
  ): Promise<number> {
    const pageSize = opts.pageSize ?? 500;
    const maxPages = opts.maxPages ?? 200;
    const seen = new Set<string>();
    let offset = 0;
    let pages = 0;

    for (;;) {
      if (pages >= maxPages) {
        throw new Error(`countPeopleMatching: hit the ${maxPages}-page backstop at offset ${offset}`);
      }
      const res = await this.request<{ data?: unknown[] }>('/objects/people/records/query', {
        method: 'POST',
        body: JSON.stringify({ filter, limit: pageSize, offset }),
      });
      const page = Array.isArray(res.data) ? res.data : [];
      pages += 1;
      for (const raw of page) {
        const parsed = parsePersonRow(raw);
        if (parsed) seen.add(parsed.recordId);
      }
      if (page.length < pageSize) break;
      offset += page.length;
    }

    return seen.size;
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
      const parsed = parsePersonRow(raw);
      if (parsed) out.push(parsed);
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
