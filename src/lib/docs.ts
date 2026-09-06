/**
 * Client for `/api/brain/docs` — the Google Docs sibling of the Sheets proxy.
 *
 * Implemented against Kaylee's Shared Bridge Contract (`docs/shared-bridge-contract.md`),
 * which is COMMITTED IN BOTH REPOSITORIES AND IMPLEMENTED RATHER THAN IMPORTED
 * (Rules 7 and 9). Nothing here may import from bhc-aida.
 *
 * ⚠ TEXT IS WRITTEN LITERALLY — DO NOT ESCAPE ANYTHING.
 *
 * This is the single most likely thing for a future edit to get wrong, because
 * the surrounding documentation says the opposite. Dev log §098 established
 * "escape EVERY underscore and asterisk", and that rule is correct FOR A
 * MARKDOWN WRITE: `CHANNEL_MAP fix, Interaction_Date` lost both underscores to
 * emphasis parsing and reported `verified: true`, because the arithmetic over
 * the RENDERED text was correct.
 *
 * §105 removed the transformation rather than guarding against it. This route
 * never renders markdown on the way in. Its health response says so in as many
 * words, checked live 2026-09-05:
 *
 *   "Text is written literally. This route never renders markdown on the way
 *    in, so no escaping is needed — send exactly the bytes you want stored."
 *
 * So escaping here does not protect `bhc_contact_id`; it STORES
 * `bhc\_contact\_id`. The identifiers this routine writes constantly are kept
 * intact by sending them unmodified, and by the route's own byte comparison —
 * not by pre-processing them.
 *
 * ⚠ `tabId` IS REQUIRED ON EVERY CALL THAT TAKES ONE. §2.5 of the contract:
 * an unknown or misspelled optional parameter is silently discarded, reads as
 * absent, and the operation defaults to the FIRST TAB. The route makes it
 * required; this client makes it non-optional in the type system as well, so
 * the failure cannot be expressed here either.
 *
 * ⚠ TWO INDEX SPACES, ONE SET OF NAMES. `find` returns `startIndex`/`endIndex`
 * (DOCUMENT indices, what the write actions take) AND
 * `plainTextStartIndex`/`plainTextEndIndex` (offsets into what `read` returns).
 * Phase 1 shipped the plain-text offsets under the document-index names; a
 * caller passing one into the other writes to the wrong place while every
 * parameter name matches. `FindResult` keeps them in separately-named fields
 * and `DocRange` accepts only the document ones.
 */

import { requestJson, withRetry, type RetryOptions } from './http.js';

export interface DocsClientOptions {
  readonly token: string;
  readonly url: string;
  readonly onRetry?: RetryOptions['onRetry'];
}

/** Every envelope carries this, including on failure paths (Rules 3, 12, 13). */
interface Envelope {
  readonly ok?: boolean;
  readonly error?: string;
  readonly writeMayHaveLanded?: boolean;
  readonly phase?: string;
  readonly safeToRetry?: boolean;
  readonly validActions?: readonly string[];
  readonly validParameters?: readonly string[];
}

export interface TabInfo {
  readonly tabId: string;
  readonly title: string;
  readonly index: number;
  readonly charCount: number;
  readonly charCountScope: string;
}

export interface DocHeading {
  readonly headingId: string;
  readonly level: number;
  readonly text: string;
  /** DOCUMENT index space. */
  readonly startIndex: number;
  readonly endIndex: number;
  /** Offset into format "text". NEVER pass this to a write. */
  readonly plainTextStartIndex: number;
  /**
   * False when Google gave the heading no anchor. The route lists it rather
   * than omitting it, so an unlinkable entry is visible instead of missing.
   */
  readonly linkable: boolean;
  /**
   * ⚠ THE ROUTE BUILDS THIS. Prefer it over assembling
   * `…/edit?tab=<tabId>#heading=<headingId>` by hand — the same string
   * concatenated in two places is the shape that drifts, and a wrong anchor
   * writes a link that resolves to the top of the document while every
   * verification still passes.
   */
  readonly url: string;
}

export interface ReadResult {
  readonly tabId: string;
  readonly tabTitle: string;
  readonly content: string;
  readonly charCount: number;
  readonly charCountScope: string;
  readonly returnedCharCount: number;
  readonly truncated: boolean;
  readonly preReadMs: number;
  /** Present only when `includeHeadings` was requested. */
  readonly headings?: readonly DocHeading[];
  readonly headingCount?: number;
  readonly unlinkableHeadingCount?: number;
}

export interface FindResult {
  readonly matchCount: number;
  /** DOCUMENT index. The one the write actions take. */
  readonly startIndex: number;
  readonly endIndex: number;
  /** Offset into what `read` returns. NEVER pass this to a write. */
  readonly plainTextStartIndex: number;
  readonly plainTextEndIndex: number;
  readonly context: string;
}

/** Rule 6's envelope. A write is done only when `verified` AND `deltaVariance === 0`. */
export interface WriteResult {
  readonly verified: boolean;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly delta: number;
  readonly expectedDelta: number;
  readonly deltaVariance: number;
  readonly byteComparison?: string;
  /**
   * insertLink only — TWO INDEPENDENT DIMENSIONS, AND THE OUTER `verified` IS
   * NOT A SUBSTITUTE FOR EITHER.
   *
   * `contentVerified` is the byte comparison: the characters landed. It is
   * exactly as true for a plain unlinked run as for a linked one, because the
   * text is identical either way.
   *
   * `linkVerified` re-reads and confirms the STORED LINK resolves. The state
   * this catches — contentVerified true, linkVerified false — is a reference
   * line that reads correctly and is not clickable, which is precisely the
   * defect this whole change exists to remove. Checking only `verified` would
   * let it through the moment the route's own AND ever loosened.
   */
  readonly contentVerified?: boolean;
  readonly linkVerified?: boolean;
}

export class DocsWriteUnverified extends Error {
  constructor(
    message: string,
    readonly result: Partial<WriteResult>,
    readonly writeMayHaveLanded: boolean,
  ) {
    super(message);
    this.name = 'DocsWriteUnverified';
  }
}

export class DocsClient {
  constructor(private readonly opts: DocsClientOptions) {}

  /**
   * ⚠ MUTATIONS ARE NEVER RETRIED (Rule 11). `withRetry` is used only for the
   * read-shaped actions; `insertText` and `replaceRange` go through
   * `callOnce`, which has no loop, so the single send is STRUCTURAL rather
   * than a constant that a later edit could raise.
   */
  private async callOnce<T>(body: Record<string, unknown>, label: string): Promise<T & Envelope> {
    const res = await requestJson<T & Envelope>(this.opts.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.unwrap(res, label);
  }

  private async call<T>(body: Record<string, unknown>, label: string): Promise<T & Envelope> {
    const res = await withRetry(
      () =>
        requestJson<T & Envelope>(this.opts.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      { label, ...(this.opts.onRetry ? { onRetry: this.opts.onRetry } : {}) },
    );
    return this.unwrap(res, label);
  }

  private unwrap<T>(res: T & Envelope, label: string): T & Envelope {
    if (res.ok === false) {
      // Rule 3: never a bare failure. Carry through whatever the route
      // enumerated, because a caller that cannot see the valid options guesses.
      const extra = [
        res.validActions ? `valid actions: ${res.validActions.join(', ')}` : '',
        res.validParameters ? `valid parameters: ${res.validParameters.join(', ')}` : '',
        res.phase ? `phase: ${res.phase}` : '',
        res.writeMayHaveLanded !== undefined ? `writeMayHaveLanded: ${res.writeMayHaveLanded}` : '',
      ].filter((s) => s !== '');
      throw new Error(`${label}: ${res.error ?? 'failed'}${extra.length ? ` (${extra.join('; ')})` : ''}`);
    }
    return res;
  }

  async health(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>({ action: 'health' }, 'docs:health');
  }

  async listTabs(documentId: string): Promise<readonly TabInfo[]> {
    const res = await this.call<{ tabs?: TabInfo[] }>(
      { action: 'listTabs', documentId },
      `docs:listTabs ${documentId}`,
    );
    return res.tabs ?? [];
  }

  /** ⚠ `tabId` is not optional. See the header note. */
  async read(documentId: string, tabId: string, includeHeadings = false): Promise<ReadResult> {
    const res = await this.call<ReadResult>(
      // ⚠ OPT-IN. Heading extraction is only requested where a link is
      // actually going to be built, so a source read that needs none does not
      // pay for it.
      { action: 'read', documentId, tabId, ...(includeHeadings ? { includeHeadings: true } : {}) },
      `docs:read ${documentId}/${tabId}`,
    );
    if (res.truncated) {
      // Rule 8's corollary: a truncated result is not the whole picture, and
      // indexing against a partial source silently under-covers it.
      throw new Error(
        `docs:read ${documentId}/${tabId} returned TRUNCATED content ` +
          `(${res.returnedCharCount} of ${res.charCount}) — refusing to index against a partial source`,
      );
    }
    return res;
  }

  async find(documentId: string, tabId: string, text: string): Promise<FindResult> {
    return this.call<FindResult>(
      { action: 'find', documentId, tabId, text },
      `docs:find ${documentId}/${tabId}`,
    );
  }

  /**
   * Insert at a DOCUMENT index. Never retried (Rule 11) — the route sends the
   * write exactly once and this client adds no loop of its own.
   */
  async insertText(args: {
    readonly documentId: string;
    readonly tabId: string;
    readonly index: number;
    readonly text: string;
  }): Promise<WriteResult> {
    const res = await this.callOnce<WriteResult>(
      { action: 'insertText', documentId: args.documentId, tabId: args.tabId, index: args.index, text: args.text },
      `docs:insertText ${args.documentId}/${args.tabId}@${args.index}`,
    );
    return assertVerified(res, `insertText @${args.index}`);
  }

  /**
   * Insert a LINKED run of text at a DOCUMENT index.
   *
   * ⚠ THE URL IS PASSED THROUGH, NEVER REPAIRED. The route refuses a URL with
   * no scheme rather than guessing one, and this client adds no normalisation
   * of its own — a corrected URL is a guess about intent, and a wrong guess
   * writes a link to the wrong place while reporting success.
   */
  async insertLink(args: {
    readonly documentId: string;
    readonly tabId: string;
    readonly index: number;
    readonly text: string;
    readonly url: string;
  }): Promise<WriteResult> {
    const res = await this.callOnce<WriteResult>(
      {
        action: 'insertLink',
        documentId: args.documentId,
        tabId: args.tabId,
        index: args.index,
        text: args.text,
        url: args.url,
      },
      `docs:insertLink ${args.documentId}/${args.tabId}@${args.index}`,
    );
    return assertLinkVerified(res, `insertLink @${args.index}`);
  }

  /**
   * Replace a DOCUMENT-index range, anchored.
   *
   * ⚠ ANCHORS MUST BE COPIED FROM A READ, NEVER RETYPED. §098: a straight
   * quote typed against a document containing curly quotes silently mismatches.
   * It fails closed — TEXT_NOT_FOUND or RANGE_ANCHOR_MISMATCH, never a wrong
   * write — but it was the most frequent self-inflicted error of the migration.
   */
  async replaceRange(args: {
    readonly documentId: string;
    readonly tabId: string;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly text: string;
    readonly expectedStartsWith: string;
    readonly expectedEndsWith: string;
  }): Promise<WriteResult> {
    if (args.expectedStartsWith === '' || args.expectedEndsWith === '') {
      // The route rejects these too; refusing here means the mistake never
      // becomes a request. `"".startsWith("")` is always true, so an empty
      // anchor is no check at all rather than a weak one.
      throw new Error('docs:replaceRange requires non-empty anchors — an empty anchor is no check at all');
    }
    const res = await this.callOnce<WriteResult>(
      {
        action: 'replaceRange',
        documentId: args.documentId,
        tabId: args.tabId,
        startIndex: args.startIndex,
        endIndex: args.endIndex,
        text: args.text,
        expectedStartsWith: args.expectedStartsWith,
        expectedEndsWith: args.expectedEndsWith,
      },
      `docs:replaceRange ${args.documentId}/${args.tabId}@${args.startIndex}-${args.endIndex}`,
    );
    return assertVerified(res, `replaceRange @${args.startIndex}-${args.endIndex}`);
  }
}

/**
 * ⚠ CHECK THE FIELD, NEVER THE RESPONSE. Rule 6: a 200 is not a verified
 * write. `verified` must be true AND `deltaVariance` must be 0 — a positive
 * but too-small delta is a truncated write reported as a success.
 */
/**
 * ⚠ BOTH DIMENSIONS, EXPLICITLY — not just the outer `verified`.
 *
 * `contentVerified: true, linkVerified: false` is a reachable state through
 * the normal write path: the text lands as plain unlinked characters and the
 * byte comparison passes, because the bytes are the same either way. Reading
 * only `verified` delegates that check to the route's own AND, which is
 * exactly the kind of second-hand assurance Rule 6's correction warns about.
 */
export function assertLinkVerified(res: WriteResult & Envelope, label: string): WriteResult {
  assertVerified(res, label);
  if (res.contentVerified === false) {
    throw new DocsWriteUnverified(`${label}: contentVerified is false`, res, res.writeMayHaveLanded ?? true);
  }
  if (res.linkVerified !== true) {
    throw new DocsWriteUnverified(
      `${label}: THE TEXT LANDED BUT THE LINK DID NOT (linkVerified=${String(res.linkVerified)}) — ` +
        'the reference reads correctly and is not clickable',
      res,
      res.writeMayHaveLanded ?? true,
    );
  }
  return res;
}

export function assertVerified(res: WriteResult & Envelope, label: string): WriteResult {
  if (res.verified === true && res.deltaVariance === 0) return res;
  throw new DocsWriteUnverified(
    `${label}: write NOT verified (verified=${String(res.verified)}, deltaVariance=${String(res.deltaVariance)}, ` +
      `delta=${String(res.delta)}, expectedDelta=${String(res.expectedDelta)})`,
    res,
    res.writeMayHaveLanded ?? true,
  );
}
