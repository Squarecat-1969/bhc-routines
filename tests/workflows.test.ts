/**
 * Every workflow must pass the env vars `loadEnv` REQUIRES.
 *
 * ⚠ THIS EXISTS BECAUSE IT ALREADY HAPPENED. `index-maintenance.yml` shipped
 * without `ATTIO_API_KEY` and failed on its first dispatch — the routine never
 * touches Attio, but `loadEnv` validates the whole shared schema up front, so
 * it aborts before any work starts. The flags were correct; the run never got
 * far enough to use them.
 *
 * The required set is derived from `loadEnv` itself rather than listed here,
 * so adding a required key to the schema fails this test instead of failing a
 * dispatch. A hardcoded list would rot in exactly the way the schema changed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';

/** Plausible values for everything the schema knows about. */
const CANDIDATES: Record<string, string> = {
  BRAIN_API_TOKEN: 'x',
  ATTIO_API_KEY: 'x',
  ANTHROPIC_BHC_ROUTINES_API: 'x',
  ZAPIER_SLACK_HOOK_URL: 'https://example.com/hook',
  FATHOM_API_KEY: 'x',
  FATHOM_API_BASE: 'https://example.com',
  RUN_TIMEZONE: 'UTC',
  SHEETS_PROXY_URL: 'https://example.com/s',
  DOCS_PROXY_URL: 'https://example.com/d',
  ATTIO_API_BASE: 'https://example.com/a',
};

/** Remove each key in turn; the ones whose absence throws are required. */
function requiredEnvKeys(): string[] {
  return Object.keys(CANDIDATES).filter((key) => {
    const partial = { ...CANDIDATES };
    delete partial[key];
    try {
      loadEnv(partial as NodeJS.ProcessEnv);
      return false;
    } catch {
      return true;
    }
  });
}

const WORKFLOW_DIR = '.github/workflows';
const workflows = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));

/** Env keys a workflow hands to a step, read literally out of the YAML. */
function envKeysIn(file: string): Set<string> {
  const text = readFileSync(`${WORKFLOW_DIR}/${file}`, 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    // `          ATTIO_API_KEY: ${{ secrets.ATTIO_API_KEY }}` — an assignment
    // from the secrets context, never a commented-out mention.
    const m = /^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*(secrets|inputs)\./.exec(line);
    if (m) keys.add(m[1]!);
    const literal = /^\s+([A-Z][A-Z0-9_]*):\s*[A-Za-z0-9_/:-]+\s*$/.exec(line);
    if (literal) keys.add(literal[1]!);
  }
  return keys;
}

describe('the env schema', () => {
  it('requires exactly BRAIN_API_TOKEN and ATTIO_API_KEY', () => {
    // Pinned so that widening the required set is a deliberate act that
    // updates this test, rather than something a workflow discovers at 3am.
    expect(requiredEnvKeys().sort()).toEqual(['ATTIO_API_KEY', 'BRAIN_API_TOKEN']);
  });
});

describe('every workflow', () => {
  it('finds workflow files to check', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  for (const file of workflows) {
    it(`${file} passes every env var loadEnv requires`, () => {
      const passed = envKeysIn(file);
      const missing = requiredEnvKeys().filter((k) => !passed.has(k));
      expect(missing, `${file} would abort in loadEnv before doing any work`).toEqual([]);
    });
  }
});
