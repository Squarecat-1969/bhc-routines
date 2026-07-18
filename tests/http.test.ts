/**
 * Regression test for a real bug hit on the first live PASS 4 run (2026-07-18):
 * Slack's incoming-webhook endpoint returns the literal text "ok" on success,
 * not JSON. `requestJson` unconditionally JSON.parses the body, so a fully
 * successful Slack post crashed the run with a SyntaxError afterward — the
 * message still went out, but the process exited non-zero, which would mark a
 * successful cadence write as a failed CI run.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError, requestJson, requestText } from '../src/lib/http.js';

describe('requestText vs requestJson against a plain-text response', () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok'); // exactly what Slack's incoming webhook returns
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('requestText succeeds on a plain-text 200 response', async () => {
    await expect(requestText(url, { method: 'POST' })).resolves.toBe('ok');
  });

  it('requestJson throws on the same response — this is the bug that shipped', async () => {
    await expect(requestJson(url, { method: 'POST' })).rejects.toThrow(SyntaxError);
  });
});

describe('requestText error handling', () => {
  it('still throws HttpError on a non-2xx response, same as requestJson', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('server error');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/`;

    await expect(requestText(url, { method: 'POST' })).rejects.toThrow(HttpError);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
