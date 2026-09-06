/**
 * The /api/brain/docs client. Real HTTP against a local fake, because the
 * three properties that matter here cannot be checked by inspection:
 * `tabId` always being sent, mutations never retrying, and an unverified
 * write throwing rather than being reported as done.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { DocsClient, DocsWriteUnverified, assertLinkVerified, assertVerified } from '../../src/lib/docs.js';

interface Recorded { readonly body: Record<string, unknown>; }

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function fake(handler: (body: Record<string, unknown>, n: number) => { status: number; json: unknown }) {
  const seen: Recorded[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ body });
      const out = handler(body, ++n);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { seen, client: new DocsClient({ token: 't', url: `http://127.0.0.1:${port}` }) };
}

const okWrite = { ok: true, verified: true, charsBefore: 10, charsAfter: 20, delta: 10, expectedDelta: 10, deltaVariance: 0 };

describe('tabId', () => {
  // ⚠⚠ A WRITE WITHOUT ONE SILENTLY RESOLVES TO THE FIRST TAB.
  it('is sent on EVERY call that takes one', async () => {
    const { seen, client } = await fake((b) =>
      b['action'] === 'read'
        ? { status: 200, json: { ok: true, content: 'x', charCount: 1, returnedCharCount: 1, truncated: false, preReadMs: 1, tabId: 't.9', tabTitle: 'T' } }
        : b['action'] === 'find'
          ? { status: 200, json: { ok: true, matchCount: 1, startIndex: 5, endIndex: 9, plainTextStartIndex: 4, plainTextEndIndex: 8, context: '' } }
          : { status: 200, json: okWrite },
    );

    await client.read('doc', 't.9');
    await client.find('doc', 't.9', 'anchor');
    await client.insertText({ documentId: 'doc', tabId: 't.9', index: 5, text: 'x' });
    await client.replaceRange({ documentId: 'doc', tabId: 't.9', startIndex: 5, endIndex: 9, text: 'x', expectedStartsWith: 'a', expectedEndsWith: 'b' });

    expect(seen).toHaveLength(4);
    for (const r of seen) expect(r.body['tabId']).toBe('t.9');
  });
});

describe('escaping', () => {
  // ⚠⚠ THE ROUTE WRITES LITERAL BYTES. Escaping would STORE the backslashes.
  it('sends identifier-shaped text through UNMODIFIED', async () => {
    const { seen, client } = await fake(() => ({ status: 200, json: okWrite }));
    const text = '· §118 · 2026-09-01 · Log “bhc_contact_id and last_email_interaction are *both* empty”';
    await client.insertText({ documentId: 'doc', tabId: 't.9', index: 1, text });
    expect(seen[0]!.body['text']).toBe(text);
    expect(String(seen[0]!.body['text'])).not.toContain('\\');
  });
});

describe('verification', () => {
  it('accepts only verified AND deltaVariance 0', () => {
    expect(() => assertVerified({ ...okWrite, verified: false } as never, 'x')).toThrow(DocsWriteUnverified);
    // A positive but too-small delta is a TRUNCATED WRITE, not a success.
    expect(() => assertVerified({ ...okWrite, delta: 4, deltaVariance: 6 } as never, 'x')).toThrow(DocsWriteUnverified);
    expect(assertVerified(okWrite as never, 'x').verified).toBe(true);
  });

  it('throws rather than reporting an unverified write as done', async () => {
    const { client } = await fake(() => ({ status: 200, json: { ...okWrite, verified: false, deltaVariance: 3 } }));
    await expect(client.insertText({ documentId: 'd', tabId: 't', index: 1, text: 'x' })).rejects.toThrow(/NOT verified/);
  });
});

describe('retry policy', () => {
  it('retries a read', async () => {
    const { seen, client } = await fake((_b, n) =>
      n < 2
        ? { status: 503, json: { ok: false, error: 'upstream' } }
        : { status: 200, json: { ok: true, content: 'x', charCount: 1, returnedCharCount: 1, truncated: false, preReadMs: 1, tabId: 't', tabTitle: 'T' } },
    );
    await client.read('d', 't');
    expect(seen.length).toBeGreaterThan(1);
  });

  // ⚠ Rule 11: a mutating call is NEVER retried, whatever the status code.
  it('sends a write EXACTLY ONCE, even on a 503', async () => {
    const { seen, client } = await fake(() => ({ status: 503, json: { ok: false, error: 'upstream' } }));
    await expect(client.insertText({ documentId: 'd', tabId: 't', index: 1, text: 'x' })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('guards', () => {
  it('refuses an empty anchor — an empty anchor is no check at all', async () => {
    const { seen, client } = await fake(() => ({ status: 200, json: okWrite }));
    await expect(
      client.replaceRange({ documentId: 'd', tabId: 't', startIndex: 1, endIndex: 2, text: 'x', expectedStartsWith: '', expectedEndsWith: 'b' }),
    ).rejects.toThrow(/empty anchor/);
    expect(seen).toHaveLength(0);
  });

  it('refuses a TRUNCATED read — indexing a partial source silently under-covers it', async () => {
    const { client } = await fake(() => ({
      status: 200,
      json: { ok: true, content: 'x', charCount: 100, returnedCharCount: 1, truncated: true, preReadMs: 1, tabId: 't', tabTitle: 'T' },
    }));
    await expect(client.read('d', 't')).rejects.toThrow(/TRUNCATED/);
  });

  it('carries the route\'s enumerated options into the error (Rule 3)', async () => {
    const { client } = await fake(() => ({
      status: 200,
      json: { ok: false, error: 'Unrecognised action "x".', validActions: ['health', 'read'] },
    }));
    await expect(client.listTabs('d')).rejects.toThrow(/valid actions: health, read/);
  });
});

describe('insertLink — BOTH verification dimensions', () => {
  const linked = { ...okWrite, contentVerified: true, linkVerified: true };

  it('accepts only when contentVerified AND linkVerified are both true', () => {
    expect(assertLinkVerified(linked as never, 'x').verified).toBe(true);
  });

  // ⚠⚠ THE STATE THIS WHOLE CHANGE EXISTS TO CATCH.
  it('REJECTS text that landed without its link', () => {
    // contentVerified true, linkVerified false = the characters are right and
    // the line is not clickable. The byte comparison cannot tell the
    // difference, because the bytes are identical either way.
    expect(() =>
      assertLinkVerified({ ...linked, linkVerified: false } as never, 'x'),
    ).toThrow(/THE TEXT LANDED BUT THE LINK DID NOT/);
  });

  it('rejects a missing linkVerified rather than treating absence as success', () => {
    expect(() => assertLinkVerified({ ...okWrite } as never, 'x')).toThrow(DocsWriteUnverified);
  });

  it('rejects contentVerified false', () => {
    expect(() => assertLinkVerified({ ...linked, contentVerified: false } as never, 'x')).toThrow(/contentVerified/);
  });

  it('still requires the outer envelope — deltaVariance must be 0', () => {
    expect(() => assertLinkVerified({ ...linked, deltaVariance: 4 } as never, 'x')).toThrow(DocsWriteUnverified);
  });

  it('sends tabId, index, text and url, and never repairs the url', async () => {
    const { seen, client } = await fake(() => ({ status: 200, json: linked }));
    await client.insertLink({ documentId: 'd', tabId: 't.9', index: 12, text: '§128 · 2026-09-05 · Log', url: 'https://docs.google.com/x#heading=h.a' });
    expect(seen[0]!.body).toMatchObject({
      action: 'insertLink', documentId: 'd', tabId: 't.9', index: 12,
      text: '§128 · 2026-09-05 · Log', url: 'https://docs.google.com/x#heading=h.a',
    });
  });

  it('sends the link write exactly once, even on a 503 (Rule 11)', async () => {
    const { seen, client } = await fake(() => ({ status: 503, json: { ok: false, error: 'upstream' } }));
    await expect(client.insertLink({ documentId: 'd', tabId: 't', index: 1, text: 'a', url: 'https://e' })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
