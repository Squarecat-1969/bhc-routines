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
import { EXCLUSIONS_HEADER, QUEUE_HEADER, TRIAGE_RANGES } from '../../src/config/triage-constants.js';

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
  // --- Contacts Triage additions ---
  /** Record-level created_at (ISO). Drives the compromise-cohort predicate. */
  createdAt?: string;
  description?: string;
  /** Attio's computed connection signals — the primary scoring input. */
  strengthLegacy?: number;
  strengthLabel?: string;
  firstInteractionAt?: string;
  lastInteractionAt?: string;
  lastInteractionSubject?: string;
  lastInteractionDirection?: string;
  lastMeetingSummary?: string;
  companyRecordId?: string;
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

  // --- Contacts Triage ---
  /** Existing Contacts_Triage_Queue!A2:V rows. Mutated in place by writes, so a read-back sees them. */
  triageQueue?: unknown[][];
  /** Existing Contact_Exclusions!A2:G rows. Appends land here. */
  triageExclusions?: unknown[][];
  /** Simulate the Contacts_Triage_Queue tab not existing (its header read fails). */
  triageQueueTabMissing?: boolean;
  /** Simulate the Contact_Exclusions tab not existing. */
  triageExclusionsTabMissing?: boolean;
  /** Return a header row that doesn't match QUEUE_HEADER — the shape-contract guard. */
  triageQueueHeaderOverride?: unknown[];
  /** Return an empty header row, as a brand-new tab would. */
  triageQueueHeaderEmpty?: boolean;
  /** Make the unfiltered people-enumeration query fail with this status. */
  peopleQueryFailWith?: number;
  /** Make the bhc_contact_id cross-check query fail — simulates an unsupported filter operator. */
  crossCheckFailWith?: number;
  /** Page size at which the enumeration query paginates. Default 500 (matches production). */
  peoplePageSize?: number;
  /**
   * Range prefix whose appends return HTTP 200 with `updatedRows: 0` — a
   * success that wrote nothing. Reproduces the unexplained 2026-08-14
   * Activity_Log behaviour so the instrumentation for it can be tested.
   */
  appendZeroRowsFor?: string;
  /** Company record_id -> name, for resolving people's `company` references. */
  companies?: Record<string, string>;
  /** Make the companies query fail — the company column degrades to blank. */
  companiesFailWith?: number;
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
/** 0-based index -> A1 letters, for reproducing Sheets' own error messages. */
function columnIndexToLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

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

/**
 * Parses a multi-row A1 range like "Contacts_Triage_Queue!A2:V57". Returns
 * null for open-ended ranges ("A2:V"), which the callers treat as "the whole
 * data block" rather than a specific window.
 */
function parseBlockRange(range: string): { sheet: string; startCol: number; endCol: number; startRow: number; endRow: number } | null {
  const m = /^([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  const [, sheet, startColLetters, startRowStr, endColLetters, endRowStr] = m;
  return {
    sheet: sheet!,
    startCol: columnLetterToIndex(startColLetters!),
    endCol: columnLetterToIndex(endColLetters!),
    startRow: Number(startRowStr),
    endRow: Number(endRowStr),
  };
}

/** Real Sheets omits trailing all-blank rows from a read; the blank-trailing-rows logic depends on that. */
function trimTrailingBlankRows(rows: unknown[][]): unknown[][] {
  const out = [...rows];
  while (out.length > 0 && (out[out.length - 1] ?? []).every((v) => v === '' || v === null || v === undefined)) {
    out.pop();
  }
  return out;
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
    if (person.description !== undefined) values['description'] = [{ value: person.description }];
    if (person.strengthLegacy !== undefined)
      values['strongest_connection_strength_legacy'] = [{ value: person.strengthLegacy, attribute_type: 'number' }];
    if (person.strengthLabel !== undefined)
      values['strongest_connection_strength'] = [{ option: { title: person.strengthLabel } }];
    if (person.firstInteractionAt !== undefined)
      values['first_interaction'] = [{ interaction_type: 'email', interacted_at: person.firstInteractionAt }];
    if (person.lastInteractionAt !== undefined)
      values['last_interaction'] = [{ interaction_type: 'email', interacted_at: person.lastInteractionAt }];
    if (person.lastInteractionSubject !== undefined)
      values['last_interaction_subject'] = [{ value: person.lastInteractionSubject }];
    if (person.lastInteractionDirection !== undefined)
      values['last_interaction_direction'] = [{ option: { title: person.lastInteractionDirection } }];
    if (person.lastMeetingSummary !== undefined)
      values['last_meeting_summary'] = [{ value: person.lastMeetingSummary }];
    if (person.companyRecordId !== undefined)
      values['company'] = [{ target_object: 'companies', target_record_id: person.companyRecordId }];
    return values;
  }

  /** One row of a `records/query` response, including the top-level created_at Contacts Triage keys off. */
  private personToQueryRow(id: string, person: FakePerson): Record<string, unknown> {
    return {
      id: { record_id: id },
      ...(person.createdAt !== undefined ? { created_at: person.createdAt } : {}),
      values: this.personToValues(person),
    };
  }

  /**
   * Requests that actually change something. Method alone isn't enough:
   * Attio's list-entries and records-query endpoints are reads that happen to
   * be POSTs (the filter goes in the body), so they're excluded by path. The
   * /sheets path is excluded here because writes to it are asserted through
   * `sheetsWrites`, which can tell a read from an update.
   */
  get mutatingRequests(): RecordedRequest[] {
    const READ_ONLY_POSTS = ['/entries/query', '/records/query'];
    return this.requests.filter(
      (r) => r.method !== 'GET' && !READ_ONLY_POSTS.some((p) => r.path.endsWith(p)) && r.path !== '/sheets',
    );
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
        // --- Contacts Triage tabs ---
        if (range === TRIAGE_RANGES.queueHeader) {
          if (this.config.triageQueueTabMissing) return send(400, { error: 'Unable to parse range: Contacts_Triage_Queue!A1:V1' });
          if (this.config.triageQueueHeaderEmpty) return send(200, { values: [] });
          if (this.config.triageQueueHeaderOverride) return send(200, { values: [this.config.triageQueueHeaderOverride] });
          return send(200, { values: [[...QUEUE_HEADER]] });
        }
        if (range === TRIAGE_RANGES.exclusionsHeader) {
          if (this.config.triageExclusionsTabMissing) return send(400, { error: 'Unable to parse range: Contact_Exclusions!A1:G1' });
          return send(200, { values: [[...EXCLUSIONS_HEADER]] });
        }
        if (range === TRIAGE_RANGES.queueData) {
          return send(200, { values: trimTrailingBlankRows(this.config.triageQueue ?? []) });
        }
        if (range === TRIAGE_RANGES.exclusionsData) {
          return send(200, { values: this.config.triageExclusions ?? [] });
        }

        if (range === RANGES.pipelineCacheHeader) {
          if (this.config.pipelineCacheTabMissing) return send(400, { error: 'Unable to parse range: Pipeline_Cache!A1:R1' });
          return send(200, { values: [['BHC_ID']] });
        }
        if (range === RANGES.pipelineCachePriorIds) return send(200, { values: this.config.pipelineCachePriorIds ?? [] });
        if (range === RANGES.nameConflictsAll) return send(200, { values: this.config.nameConflicts ?? [] });
        if (range === RANGES.brainCompleteData) return send(200, { values: this.config.brainComplete ?? [] });
        if (range?.startsWith('Brain_Complete')) {
          // Narrower single-row reads (e.g. Brain_Complete!U10:U10, used by
          // branch.ts's read-then-append correction logic) — same slicing
          // fix as Activity_Log needed, for the same reason: the exact
          // range string PASS 1/5 use for the bulk read doesn't match a
          // column-scoped row read, so without this it would silently fall
          // through to an empty-array default instead of the row's real data.
          const parsed = parseSingleRowRange(range);
          if (parsed) {
            const rows = this.config.brainComplete ?? [];
            const fullRow = (rows[parsed.row - 2] ?? []) as unknown[]; // data starts at row 2
            const slice = fullRow.slice(parsed.startCol, parsed.endCol + 1).map((v) => String(v ?? ''));
            return send(200, { values: [slice] });
          }
        }
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

      // --- Contacts Triage writes. The queue is a full-block rewrite plus a
      // trailing blank-out, and the routine reads it straight back to verify —
      // so the store has to reflect both, exactly like real Sheets does.
      if (action === 'update' && range?.startsWith('Contacts_Triage_Queue')) {
        const parsed = parseBlockRange(range);
        const newRows = ((body as { values?: unknown[][] })?.values ?? []) as unknown[][];
        if (parsed) {
          // Real Sheets rejects a row wider than its target range. A live run
          // on 2026-08-09 died on exactly that ("tried writing to column [W]")
          // while every test passed, because this fake accepted any width.
          // Now it doesn't.
          const rangeWidth = parsed.endCol - parsed.startCol + 1;
          const tooWide = newRows.find((r) => r.length > rangeWidth);
          if (tooWide) {
            return send(400, {
              error: {
                code: 400,
                message: `Requested writing within range [${range}], but tried writing to column [${columnIndexToLetter(parsed.startCol + tooWide.length - 1)}]`,
                status: 'INVALID_ARGUMENT',
              },
            });
          }
          const store = [...(this.config.triageQueue ?? [])];
          if (parsed.startRow === 1) {
            // Header write on a brand-new tab — not part of the data block.
            this.config.triageQueueHeaderEmpty = false;
          } else {
            newRows.forEach((row, i) => {
              store[parsed.startRow - 2 + i] = row;
            });
            this.config.triageQueue = store;
          }
        }
        return send(200, {});
      }
      if (action === 'append' && range?.startsWith('Contact_Exclusions')) {
        const newRows = ((body as { values?: unknown[][] })?.values ?? []) as unknown[][];
        this.config.triageExclusions = [...(this.config.triageExclusions ?? []), ...newRows];
        return send(200, {});
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

      if (action === 'update' && (range?.startsWith('Activity_Log') || range?.startsWith('Contact_History') || range?.startsWith('Brain_Complete'))) {
        // A correction write (qa-readback.ts, branch.ts) needs to actually
        // modify the stored full-row array, not just be acknowledged —
        // otherwise the re-read done immediately after would still see the
        // pre-write value.
        const parsed = parseSingleRowRange(range);
        if (parsed) {
          const store = range.startsWith('Activity_Log')
            ? this.config.activityLog
            : range.startsWith('Contact_History')
              ? this.config.contactHistory
              : this.config.brainComplete;
          if (store) {
            const idx = parsed.row - 2; // all three tabs' data starts at row 2
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
      //
      // An append reports `updates.updatedRows`, as the real API does —
      // write-row.ts now gates activityLogWritten on it, so a fake that
      // omitted it would report every append as having landed nothing.
      // `appendZeroRowsFor` simulates the 2026-08-14 behaviour: a 200 that
      // wrote nothing.
      if (action === 'append') {
        const rowsSent = ((body as { values?: unknown[][] })?.values ?? []).length;
        const zeroFor = this.config.appendZeroRowsFor;
        const landed = zeroFor && range?.startsWith(zeroFor) ? 0 : rowsSent;
        return send(200, { updates: { updatedRows: landed } });
      }
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

    // --- Attio: people query. Three callers share this endpoint, told apart
    // by their filter: PASS 2's email search, Contacts Triage's bhc_contact_id
    // cross-check, and Contacts Triage's unfiltered full enumeration.
    if (path === '/objects/people/records/query' && req.method === 'POST') {
      const parsedBody = (body ?? {}) as {
        filter?: Record<string, unknown>;
        limit?: number;
        offset?: number;
      };
      const filter = parsedBody.filter;

      if (filter && 'email_addresses' in filter) {
        const contains = (filter['email_addresses'] as { $contains?: string })?.$contains ?? '';
        const results = this.config.emailSearchResults?.[contains.toLowerCase()] ?? [];
        const data = results.map((person, i) => ({
          id: { record_id: `search-result-${i}` },
          values: this.personToValues(person),
        }));
        return send(200, { data });
      }

      if (filter && 'bhc_contact_id' in filter) {
        if (this.config.crossCheckFailWith) {
          return send(this.config.crossCheckFailWith, { error: 'unsupported filter operator' });
        }
        // Live Attio only supports $starts_with here (not $not_empty) — honour
        // the prefix so the fake can't pass a filter the real API would reject.
        const prefix = (filter['bhc_contact_id'] as { $starts_with?: string })?.$starts_with ?? '';
        const bridged = Object.entries(this.config.people).filter(([, p]) =>
          (p.bhcContactId ?? '') !== '' && (p.bhcContactId ?? '').startsWith(prefix),
        );
        return send(200, { data: bridged.map(([id, p]) => this.personToQueryRow(id, p)) });
      }

      if (this.config.peopleQueryFailWith) {
        return send(this.config.peopleQueryFailWith, { error: 'forced people-query failure' });
      }
      const pageSize = parsedBody.limit ?? this.config.peoplePageSize ?? 500;
      const offset = parsedBody.offset ?? 0;
      const all = Object.entries(this.config.people);
      const page = all.slice(offset, offset + pageSize).map(([id, p]) => this.personToQueryRow(id, p));
      return send(200, { data: page });
    }

    // --- Attio: companies, for resolving people's `company` references ---
    if (path === '/objects/companies/records/query' && req.method === 'POST') {
      if (this.config.companiesFailWith) return send(this.config.companiesFailWith, { error: 'forced companies failure' });
      const data = Object.entries(this.config.companies ?? {}).map(([id, name]) => ({
        id: { record_id: id },
        values: { name: [{ value: name }] },
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
