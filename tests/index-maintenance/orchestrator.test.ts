/**
 * The run, end to end, over real HTTP against a fake /api/brain/docs.
 *
 * Covers the properties that only exist once the whole thing is wired: the
 * dry-run guarantee, the transport-contract check, and confirmed-not-intended
 * write counting.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { DocsClient } from '../../src/lib/docs.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runIndexMaintenance } from '../../src/passes/index-maintenance/index.js';
import { renderReport } from '../../src/passes/index-maintenance/report.js';
import { PROMPT_VERSION } from '../../src/passes/index-maintenance/failure-state.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const GROUP_TAB = [
  'GROUP: Routines',
  'Contacts Triage  (1 reference)',
  '· §117 · 2026-09-01 · Log “Suppression against prior human decisions”',
].join('\n');

const SOURCE_TAB = [
  '§117 — Suppression against prior human decisions · 2026-09-01',
  'already indexed.',
  '',
  '§130 — A brand new entry · 2026-09-05',
  'bhc_contact_id and last_email_interaction are *both* empty on every record.',
].join('\n');

interface FakeOpts {
  readonly literalNote?: string;
  readonly writeResponse?: Record<string, unknown>;
}

async function fake(opts: FakeOpts = {}) {
  const writes: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw || '{}') as Record<string, unknown>;
      const send = (json: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      switch (b['action']) {
        case 'health':
          return send({
            ok: true,
            budgetMs: 45000,
            literalTextNote:
              opts.literalNote ??
              'Text is written literally. This route never renders markdown on the way in, so no escaping is needed.',
          });
        case 'listTabs':
          return send({
            ok: true,
            tabs: [
              { tabId: 't.0', title: 'SOURCES INDEXED', index: 0, charCount: 10, charCountScope: 'tab' },
              { tabId: 't.rout', title: 'GROUP: Routines', index: 1, charCount: 100, charCountScope: 'tab' },
              { tabId: 't.floyr53yoysv', title: 'ADDITIONAL TERMS', index: 2, charCount: 50, charCountScope: 'tab' },
            ],
          });
        case 'read': {
          const content = b['tabId'] === 't.rout' ? GROUP_TAB : b['tabId'] === 't.floyr53yoysv' ? 'ADDITIONAL TERMS' : SOURCE_TAB;
          return send({
            ok: true, content, charCount: content.length, returnedCharCount: content.length,
            truncated: false, preReadMs: 5, tabId: b['tabId'], tabTitle: 'x',
          });
        }
        case 'find':
          return send({ ok: true, matchCount: 1, startIndex: 20, endIndex: 40, plainTextStartIndex: 19, plainTextEndIndex: 39, context: '' });
        case 'insertText':
        case 'replaceRange':
          writes.push(b);
          return send(opts.writeResponse ?? { ok: true, verified: true, charsBefore: 1, charsAfter: 2, delta: 1, expectedDelta: 1, deltaVariance: 0 });
        default:
          return send({ ok: false, error: 'unknown' });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { writes, docs: new DocsClient({ token: 't', url: `http://127.0.0.1:${port}` }) };
}

const anthropic = {
  async complete() {
    return JSON.stringify({ terms: ['Contacts Triage'], proposedTerms: [], reason: 'r' });
  },
} as never;

const SOURCES = ['log-003 · September 2026'];

/** A minimal Sheets stand-in holding the failure-state tab. */
function fakeSheets(rows: unknown[][], opts: { missing?: boolean } = {}) {
  const written: unknown[][] = [];
  return {
    written,
    client: {
      async read() {
        if (opts.missing) throw new Error('Unable to parse range: Index_Maintenance_State!A2:G');
        return rows;
      },
      async update(_range: string, values: unknown[][]) { written.push(...values); },
      async append() { return { updatedRows: 0, updatesBlockPresent: false, updatedRowsFieldPresent: false }; },
    } as never,
  };
}

describe('the dry-run guarantee', () => {
  it('issues ZERO writes in dry run, and still plans the full change set', async () => {
    const { writes, docs } = await fake();
    const r = await runIndexMaintenance({ dryRun: true, docs, anthropic, logger: silentLogger, sourceLabels: SOURCES });
    expect(r.aborted).toBe(false);
    expect(writes).toHaveLength(0);
    expect(r.writesAttempted).toBe(0);
    expect(r.planned.length).toBeGreaterThan(0);
  });
});

describe('the transport contract', () => {
  // ⚠⚠ EVERY WRITE SENDS RAW BYTES ON THIS PROMISE.
  it('ABORTS if the route stops promising literal writes', async () => {
    // If the route ever starts rendering markdown, unescaped identifiers lose
    // their underscores to emphasis parsing and the envelope still reports
    // verified — §098's exact failure, silently.
    const { writes, docs } = await fake({ literalNote: 'Markdown is rendered on the way in.' });
    const r = await runIndexMaintenance({ dryRun: false, docs, anthropic, logger: silentLogger, sourceLabels: SOURCES });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toContain('NO LONGER PROMISES LITERAL WRITES');
    expect(writes).toHaveLength(0);
  });
});

describe('the watermark, end to end', () => {
  it('judges only the unindexed entry', async () => {
    const { docs } = await fake();
    const r = await runIndexMaintenance({ dryRun: true, docs, anthropic, logger: silentLogger, sourceLabels: SOURCES });
    expect(r.unindexed).toEqual(['§130']);
    expect(r.llmCallsMade).toBe(1);
  });
});

describe('writes', () => {
  it('sends identifier-shaped text unescaped, and counts CONFIRMED writes', async () => {
    const { writes, docs } = await fake();
    const r = await runIndexMaintenance({ dryRun: false, docs, anthropic, logger: silentLogger, sourceLabels: SOURCES });
    expect(r.writesConfirmed).toBe(r.writesAttempted);
    expect(r.writesConfirmed).toBeGreaterThan(0);
    const inserted = writes.map((w) => String(w['text'] ?? '')).join('\n');
    expect(inserted).toContain('bhc_contact_id');
    expect(inserted).not.toContain('\\');
  });

  it('counts CONFIRMED, not attempted, when a write comes back unverified', async () => {
    const { docs } = await fake({
      writeResponse: { ok: true, verified: false, charsBefore: 1, charsAfter: 1, delta: 0, expectedDelta: 9, deltaVariance: 9 },
    });
    const r = await runIndexMaintenance({ dryRun: false, docs, anthropic, logger: silentLogger, sourceLabels: SOURCES });
    expect(r.writesAttempted).toBeGreaterThan(0);
    expect(r.writesConfirmed).toBe(0);
    expect(r.warnings.join(' ')).toContain('write FAILED');
  });
});

describe('source selection', () => {
  it('names the valid labels when given an unknown one (Rule 3)', async () => {
    const { docs } = await fake();
    const r = await runIndexMaintenance({ dryRun: true, docs, anthropic, logger: silentLogger, sourceLabels: ['nope'] });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toContain('Valid labels:');
  });
});

describe('blocked entries', () => {
  const blockedRow = (locator: string, failures: number, blocked: string, prompt: string, vocab: number) =>
    [locator, failures, blocked, 'terms: Array must contain at most 12 element(s)', '2026-09-07', prompt, vocab];

  it('SKIPS a blocked entry and names it in the report, with count and last error', async () => {
    const { docs } = await fake();
    // The vocabulary in this fixture is 1 term ("Contacts Triage").
    const sheets = fakeSheets([blockedRow('§130', 3, 'TRUE', PROMPT_VERSION, 1)]);
    const r = await runIndexMaintenance({
      dryRun: true, docs, sheets: sheets.client, anthropic, logger: silentLogger, sourceLabels: SOURCES,
    });
    expect(r.blockingActive).toBe(true);
    // Not attempted — that is the whole point: no LLM call is spent on it.
    expect(r.llmCallsMade).toBe(0);
    expect(r.planned).toEqual([]);
    // ⚠ AND IT IS VISIBLE, BY NAME, WITH ITS EVIDENCE.
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]!.locator).toBe('§130');
    expect(r.blocked[0]!.failures).toBe(3);
    expect(r.blocked[0]!.lastError).toContain('at most 12 element(s)');
    const text = renderReport(r);
    expect(text).toContain('BLOCKED ENTRIES');
    expect(text).toContain('§130');
    expect(text).toContain('3 consecutive failure(s)');
    expect(text).toContain('at most 12 element(s)');
  });

  it('RE-ATTEMPTS a blocked entry once the prompt version has moved', async () => {
    const { docs } = await fake();
    const sheets = fakeSheets([blockedRow('§130', 3, 'TRUE', 'an-older-prompt', 1)]);
    const r = await runIndexMaintenance({
      dryRun: true, docs, sheets: sheets.client, anthropic, logger: silentLogger, sourceLabels: SOURCES,
    });
    expect(r.llmCallsMade).toBe(1);
    expect(r.blocked).toHaveLength(0);
  });

  it('⚠ DEGRADES LOUDLY when the state tab is absent — never silently', async () => {
    // Without the tab the routine still indexes, but a repeatedly-failing
    // entry is retried forever. That must not be invisible.
    const { docs } = await fake();
    const sheets = fakeSheets([], { missing: true });
    const r = await runIndexMaintenance({
      dryRun: true, docs, sheets: sheets.client, anthropic, logger: silentLogger, sourceLabels: SOURCES,
    });
    expect(r.blockingActive).toBe(false);
    expect(r.warnings.join(' ')).toContain('BLOCKING IS OFF');
    expect(renderReport(r)).toContain('BLOCKING IS OFF');
  });

  it('reports the blocked section on every run, even when nothing is blocked', async () => {
    const { docs } = await fake();
    const r = await runIndexMaintenance({
      dryRun: true, docs, sheets: fakeSheets([]).client, anthropic, logger: silentLogger, sourceLabels: SOURCES,
    });
    const text = renderReport(r);
    expect(text).toContain('BLOCKED ENTRIES');
    expect(text).toContain('none');
    expect(text).toContain(PROMPT_VERSION);
  });
});
