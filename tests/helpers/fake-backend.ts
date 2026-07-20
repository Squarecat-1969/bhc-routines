/**
 * A minimal stand-in for the Attio REST API and the Aida Sheets proxy, served
 * over real HTTP on a random port.
 *
 * This exists so the orchestration layer — pagination, batching, the identity
 * gate, the read-back, and above all the dry-run guarantee — can be exercised
 * end-to-end without touching production. It records every request it receives
 * so tests can assert on what was (and was not) sent.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { RANGES } from '../../src/config/constants.js';

export interface FakePerson {
  name?: string;
  bhcContactId?: string;
  lastInteraction?: string;
  jobTitle?: string;
  companyName?: string;
  linkedin?: string;
  relationshipTier?: string;
  /** Primary email first. */
  emailAddresses?: string[];
  /** For Part D's personal-context read-first-then-append writes. */
  personalNotes?: string;
  topicsOfInterest?: string;
  /** Force the read-back to return this instead of what was PATCHed. */
  readBackOverride?: string;
  /** Make GET/PATCH fail with this status. */
  failWith?: number;
}

export interface FakeEntry {
  recordId: string;
  tnbStage?: string;
  fractionalStage?: string;
  fteStage?: string;
}

export interface FakeBackendConfig {
  entries: FakeEntry[];
  people: Record<string, FakePerson>;
  /** Rows for Master_ID!A2:F — [BHC_ID, Full_Name, Location, Google_Row, Attio_Record_ID, Notes] */
  masterId: unknown[][];
  contactsHeader: unknown[];
  /** Rows for RANGES.contactsData (Contacts data starting at row 3) */
  contacts: unknown[][];
  /** When true, the Pipeline_Cache header read fails — simulates the tab not existing (spec 4.5.0). */
  pipelineCacheTabMissing?: boolean;
  /** When set, the Master_ID read fails with this status — for testing failure paths AFTER the tab guard succeeds. */
  masterIdFailWith?: number;
  /** Rows for Pipeline_Cache!A2:A — simulates a prior run's row count for the blank-trailing-rows check. */
  pipelineCachePriorIds?: unknown[][];
  /** Rows for Name_Conflicts!A2:M — existing conflict rows for the 4.5h suppression check. */
  nameConflicts?: unknown[][];
  /** Rows for Brain_Complete!A2:AD — PASS 1 housekeeping input. */
  brainComplete?: unknown[][];
  contactHistory?: unknown[][];
  /** Rows for Thread_Staging!A2:W — PASS 1 working-set input. */
  threadStaging?: unknown[][];
  /** Rows for Activity_Log!A2:U — PASS 0 placeholder input. */
  activityLog?: unknown[][];
  /** Rows for Tasks_Open!A2:M — PASS 2.5 input. */
  tasksOpen?: unknown[][];
  /** Rows for Zoom_Staging!H2:H (status column only) — PASS 5 input. */
  zoomStagingStatuses?: unknown[][];
  /** Rows for Daily_Brief!A2:A — PASS 5's existing-row lookup. */
  dailyBriefDates?: unknown[][];
  /** Rows for Reconciliation_Queue!A2:N — PASS 2.5's supersede-target lookup. */
  reconciliationQueue?: unknown[][];
  /** Attio people-search-by-email results, keyed by lowercase email. */
  emailSearchResults?: Record<string, FakePerson[]>;
  /** When set, Attio task creation fails with this status — for testing write-row.ts's failure handling. */
  taskCreateFailWith?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A1-style column letters -> 0-based index. 'A'->0, 'Z'->25, 'AA'->26,
 * 'BZ'->77, 'CA'->78, 'CG'->84. Standard base-26 with no zero digit.
 */
function columnLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parses a single-row A1 range like "Contacts!BZ10:CG10" or "Contacts!AI5:AI5".
 * Returns null for anything else (multi-row ranges, whole-column ranges,
 * etc.) — the Contacts row-store below only needs to handle the
 * single-row-single-write shape QA's read-back and write-row.ts's own
 * updates actually use.
 */
function parseSingleRowRange(range: string): { sheet: string; startCol: number; endCol: number; row: number } | null {
  const m = /^([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  const [, sheet, startColLetters, startRowStr, endColLetters, endRowStr] = m;
  if (startRowStr !== endRowStr) return null; // multi-row — not handled by the row-store
  return {
    sheet: sheet!,
    startCol: columnLetterToIndex(startColLetters!),
    endCol: columnLetterToIndex(endColLetters!),
    row: Number(startRowStr),
  };
}

export class FakeBackend {
  private server: Server | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly patched = new Map<string, Record<string, unknown>>();
  readonly createdTasks: { taskId: string; content: string; body: unknown }[] = [];
  /**
   * Per-row, per-column Contacts overrides — reflects sheets.update writes
   * on the very next sheets.read of the same cells, same "real Sheets
   * reflects a write immediately" principle already used for Brain_Complete
   * and Activity_Log appends, just for row/column UPDATES instead of
   * appends. Without this, QA read-back tests can't observe writes
   * write-row.ts itself made within the same test — the whole point of
   * a read-back check.
   */
  readonly contactsRowStore = new Map<number, Map<number, string>>();

  constructor(readonly config: FakeBackendConfig) {}

  private personToValues(person: FakePerson): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    if (person.name !== undefined) values['name'] = [{ full_name: person.name }];
    if (person.bhcContactId !== undefined) values['bhc_contact_id'] = [{ value: person.bhcContactId }];
    if (person.lastInteraction !== undefined)
      values['last_interaction'] = [
        { interaction_type: 'email', interacted_at: person.lastInteraction, attribute_type: 'interaction' },
      ];
    if (person.jobTitle !== undefined) values['job_title'] = [{ value: person.jobTitle }];
    if (person.companyName !== undefined) values['company_name'] = [{ value: person.companyName }];
    if (person.linkedin !== undefined) values['linkedin'] = [{ value: person.linkedin }];
    if (person.relationshipTier !== undefined)
      values['relationship_tier'] = [{ option: { title: person.relationshipTier } }];
    if (person.emailAddresses !== undefined)
      values['email_addresses'] = person.emailAddresses.map((e) => ({ email_address: e }));
    if (person.personalNotes !== undefined) values['personal_notes'] = [{ value: person.personalNotes }];
    if (person.topicsOfInterest !== undefined) values['topics_of_interest'] = [{ value: person.topicsOfInterest }];
    return values;
  }

  get mutatingRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/entries/query') && r.path !== '/sheets');
  }

  get sheetsWrites(): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.path === '/sheets' && (r.body as { action?: string })?.action !== 'read',
    );
  }

  async start(): Promise<{ attioBase: string; sheetsUrl: string }> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return { attioBase: `http://127.0.0.1:${port}`, sheetsUrl: `http://127.0.0.1:${port}/sheets` };
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const path = (req.url ?? '').split('?')[0] ?? '';
    this.requests.push({ method: req.method ?? 'GET', path, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // --- Sheets proxy ---
    if (path === '/sheets') {
      const { action, range } = (body ?? {}) as { action?: string; range?: string };

      if (action === 'read') {
        if (range === RANGES.pipelineCacheHeader) {
          if (this.config.pipelineCacheTabMissing) return send(400, { error: 'Unable to parse range: Pipeline_Cache!A1:R1' });
          return send(200, { values: [['BHC_ID']] });
        }
        if (range === RANGES.pipelineCachePriorIds) return send(200, { values: this.config.pipelineCachePriorIds ?? [] });
        if (range === RANGES.nameConflictsAll) return send(200, { values: this.config.nameConflicts ?? [] });
        if (range === RANGES.brainCompleteData) return send(200, { values: this.config.brainComplete ?? [] });
        if (range === RANGES.threadStagingData) return send(200, { values: this.config.threadStaging ?? [] });
        if (range?.startsWith('Activity_Log')) {
          const rows = this.config.activityLog ?? [];
          const parsed = range === 'Activity_Log!A2:A' ? null : parseSingleRowRange(range); // A2:A is a whole-column range, not single-row — let it fall through to the full-array behavior below (only col A is ever read from it, so no slicing is needed there)
          if (parsed) {
            const fullRow = (rows[parsed.row - 2] ?? []) as unknown[]; // data starts at row 2
            const slice = fullRow.slice(parsed.startCol, parsed.endCol + 1).map((v) => String(v ?? ''));
            return send(200, { values: [slice] });
          }
          return send(200, { values: rows });
        }
        if (range === RANGES.tasksOpenData) return send(200, { values: this.config.tasksOpen ?? [] });
        if (range === RANGES.zoomStagingStatus) return send(200, { values: this.config.zoomStagingStatuses ?? [] });
        if (range === RANGES.dailyBriefDates) return send(200, { values: this.config.dailyBriefDates ?? [] });
        if (range === RANGES.reconciliationQueueAll) return send(200, { values: this.config.reconciliationQueue ?? [] });
        if (range?.startsWith('Master_ID')) {
          if (this.config.masterIdFailWith) return send(this.config.masterIdFailWith, { error: 'forced Master_ID failure' });
          return send(200, { values: this.config.masterId });
        }
        if (range === RANGES.contactsHeader) return send(200, { values: [this.config.contactsHeader] });
        if (range?.startsWith('Contacts')) {
          const parsed = parseSingleRowRange(range);
          if (parsed) {
            const rowStore = this.contactsRowStore.get(parsed.row);
            const values: string[] = [];
            for (let col = parsed.startCol; col <= parsed.endCol; col++) {
              values.push(rowStore?.get(col) ?? '');
            }
            return send(200, { values: [values] });
          }
          return send(200, { values: this.config.contacts });
        }
        if (range?.startsWith('Contact_History')) return send(200, { values: this.config.contactHistory ?? [] });
        return send(200, { values: [] });
      }

      if (action === 'append') {
        // Real Sheets reflects a write on the very next read. Scoped to the
        // specific tabs that actually need this within a single fake
        // backend instance: Brain_Complete (a cross-pass test writes then
        // reads back), Activity_Log (Part D's write-row.ts re-reads col A
        // to find the row it just appended, for the col-T follow-up write),
        // and Contact_History (qa-readback.ts re-reads it to verify
        // write-row.ts's own append landed) — all the same live-lookup
        // principle as everywhere else in this project, applied to a row
        // written a moment earlier within the same test.
        if (range?.startsWith('Brain_Complete')) {
          const newRows = ((body as { values?: unknown[][] })?.values ?? []) as unknown[][];
          this.config.brainComplete = [...(this.config.brainComplete ?? []), ...newRows];
        }
        if (range?.startsWith('Activity_Log')) {
          const newRows = ((body as { values?: unknown[][] })?.values ?? []) as unknown[][];
          this.config.activityLog = [...(this.config.activityLog ?? []), ...newRows];
        }
        if (range?.startsWith('Contact_History')) {
          const newRows = ((body as { values?: unknown[][] })?.values ?? []) as unknown[][];
          this.config.contactHistory = [...(this.config.contactHistory ?? []), ...newRows];
        }
      }

      if (action === 'update' && range?.startsWith('Contacts')) {
        const parsed = parseSingleRowRange(range);
        if (parsed) {
          const newValues = (((body as { values?: unknown[][] })?.values ?? [[]])[0] ?? []) as unknown[];
          let rowStore = this.contactsRowStore.get(parsed.row);
          if (!rowStore) {
            rowStore = new Map<number, string>();
            this.contactsRowStore.set(parsed.row, rowStore);
          }
          newValues.forEach((v, i) => rowStore!.set(parsed.startCol + i, String(v ?? '')));
        }
      }

      if (action === 'update' && (range?.startsWith('Activity_Log') || range?.startsWith('Contact_History'))) {
        // A correction write (qa-readback.ts) needs to actually modify the
        // stored full-row array, not just be acknowledged — otherwise the
        // re-read qa-readback.ts does immediately after would still see the
        // pre-correction value, and every "corrects on retry" test would be
        // unable to observe the correction actually working.
        const parsed = parseSingleRowRange(range);
        if (parsed) {
          const store = range.startsWith('Activity_Log') ? this.config.activityLog : this.config.contactHistory;
          if (store) {
            const idx = parsed.row - 2; // both tabs' data starts at row 2
            const fullRow = (store[idx] ?? []) as unknown[];
            const newValues = (((body as { values?: unknown[][] })?.values ?? [[]])[0] ?? []) as unknown[];
            const updated = [...fullRow];
            newValues.forEach((v, i) => { updated[parsed.startCol + i] = v; });
            store[idx] = updated;
          }
        }
      }

      // update / append: acknowledge. The request is already recorded above
      // (this.requests / this.sheetsWrites) for tests to assert on.
      return send(200, {});
    }

    // --- Attio: list entries ---
    if (path.endsWith('/entries/query') && req.method === 'POST') {
      const { limit = 50, offset = 0 } = (body ?? {}) as { limit?: number; offset?: number };
      const page = this.config.entries.slice(offset, offset + limit).map((e, i) => {
        const entryValues: Record<string, unknown> = {};
        if (e.tnbStage) entryValues['tnb_stage'] = [{ option: { title: e.tnbStage } }];
        if (e.fractionalStage) entryValues['fractional_stage'] = [{ option: { title: e.fractionalStage } }];
        if (e.fteStage) entryValues['fte_stage'] = [{ option: { title: e.fteStage } }];
        return {
          id: { entry_id: `ent-${offset + i}` },
          parent_record_id: e.recordId,
          parent_object: 'people',
          entry_values: entryValues,
        };
      });
      return send(200, { data: page });
    }

    // --- Attio: search people by email (PASS 2's resolution cascade) ---
    if (path === '/objects/people/records/query' && req.method === 'POST') {
      const filter = (body as { filter?: { email_addresses?: { $contains?: string } } })?.filter;
      const email = (filter?.email_addresses?.$contains ?? '').toLowerCase();
      const results = this.config.emailSearchResults?.[email] ?? [];
      const data = results.map((person, i) => ({
        id: { record_id: `search-result-${i}` },
        values: this.personToValues(person),
      }));
      return send(200, { data });
    }

    // --- Attio: create task (Part D's write-row.ts) ---
    if (path === '/tasks' && req.method === 'POST') {
      const data = (body as { data?: { content?: string; linked_records?: unknown[] } })?.data;
      if (this.config.taskCreateFailWith) return send(this.config.taskCreateFailWith, { error: 'forced task-create failure' });
      const taskId = `fake-task-${this.requests.length}`;
      this.createdTasks.push({ taskId, content: data?.content ?? '', body: data });
      return send(200, { data: { id: { workspace_id: 'ws', task_id: taskId } } });
    }

    // --- Attio: person record ---
    const match = /^\/objects\/people\/records\/(.+)$/.exec(path);
    if (match) {
      const id = match[1]!;
      const person = this.config.people[id];
      if (!person) return send(404, { error: 'not found' });
      if (person.failWith) return send(person.failWith, { error: 'forced failure' });

      if (req.method === 'PATCH') {
        const values = ((body as { data?: { values?: Record<string, unknown> } })?.data?.values) ?? {};
        this.patched.set(id, values);
        return send(200, { data: { id: { record_id: id }, values: {} } });
      }

      if (req.method === 'GET') {
        const values: Record<string, unknown> = this.personToValues(person);

        const written = this.patched.get(id);
        if (written) {
          for (const [k, v] of Object.entries(written)) values[k] = [{ value: v }];
          if (person.readBackOverride !== undefined) {
            values['next_check_in_date'] = [{ value: person.readBackOverride }];
          }
        }
        return send(200, { data: { id: { record_id: id }, values } });
      }
    }

    return send(404, { error: `unhandled ${req.method} ${path}` });
  }
}
