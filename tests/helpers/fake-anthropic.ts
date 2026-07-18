import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAnthropicConfig {
  /** The raw text to return as the model's response content. */
  responseText: string;
  /** If set, the server returns this HTTP status with an error body instead. */
  failWith?: number;
}

export class FakeAnthropicBackend {
  private server: Server | null = null;
  readonly requests: unknown[] = [];

  constructor(private config: FakeAnthropicConfig) {}

  setResponseText(text: string): void {
    this.config = { ...this.config, responseText: text };
  }

  async start(): Promise<{ baseUrl: string }> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        this.requests.push(body);

        if (this.config.failWith) {
          res.writeHead(this.config.failWith, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forced failure' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: this.config.responseText }] }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}` };
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
