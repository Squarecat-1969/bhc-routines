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
  /** Rows for Thread_Staging!A2:W — PASS 1 working-set input. */
  threadStaging?: unknown[][];
  /** Rows for Activity_Log!A2:U — PASS 0 placeholder input. */
  activityLog?: unknown[][];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export class FakeBackend {
  private server: Server | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly patched = new Map<string, Record<string, unknown>>();

  constructor(private readonly config: FakeBackendConfig) {}

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
        if (range === RANGES.activityLogData) return send(200, { values: this.config.activityLog ?? [] });
        if (range?.startsWith('Master_ID')) {
          if (this.config.masterIdFailWith) return send(this.config.masterIdFailWith, { error: 'forced Master_ID failure' });
          return send(200, { values: this.config.masterId });
        }
        if (range === RANGES.contactsHeader) return send(200, { values: [this.config.contactsHeader] });
        if (range?.startsWith('Contacts')) return send(200, { values: this.config.contacts });
        return send(200, { values: [] });
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
        const values: Record<string, unknown> = {};
        if (person.name !== undefined) values['name'] = [{ full_name: person.name }];
        if (person.bhcContactId !== undefined) values['bhc_contact_id'] = [{ value: person.bhcContactId }];
        if (person.lastInteraction !== undefined)
          values['last_interaction'] = [
            {
              interaction_type: 'email',
              interacted_at: person.lastInteraction,
              attribute_type: 'interaction',
            },
          ];
        if (person.jobTitle !== undefined) values['job_title'] = [{ value: person.jobTitle }];
        if (person.companyName !== undefined) values['company_name'] = [{ value: person.companyName }];
        if (person.linkedin !== undefined) values['linkedin'] = [{ value: person.linkedin }];
        if (person.relationshipTier !== undefined)
          values['relationship_tier'] = [{ option: { title: person.relationshipTier } }];
        if (person.emailAddresses !== undefined)
          values['email_addresses'] = person.emailAddresses.map((e) => ({ email_address: e }));

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
