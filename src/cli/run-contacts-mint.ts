/**
 * STEP 4 — contacts mint, DRY RUN.
 *
 *   npm run contacts-mint:dry
 *
 * ⚠ THERE IS NO `--live`, AND THAT IS NOT AN OVERSIGHT. This entry point reads
 * both systems, decides who may be minted, and prints the exact writes a mint
 * WOULD perform. It cannot perform them: nothing it imports can write. The
 * executor is a separate build that runs only after Bobby has confirmed the
 * first single mint by hand.
 *
 * The only writes in this process are: none. `SheetsClient.read` and
 * `AttioClient.listAllPeople` are the entire I/O surface.
 *
 * ⚠ MINTING IS HUMAN-CONFIRMED, NEVER AUTOMATIC. This is a CLI a human runs and
 * reads; it is deliberately not wired into a nightly routine, and it must not
 * be. Automatic minting would have issued Raymond Yang a BHC_ID twice in three
 * days. The Hard Contracts put it plainly: "Automation and routines never mint
 * a contact on their own initiative."
 */

import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { RANGES } from '../config/constants.js';
import { TRIAGE_RANGES } from '../config/triage-constants.js';
import { AttioClient } from '../lib/attio.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient, cell } from '../lib/sheets.js';
import { enumerateUnbridged } from '../passes/contacts-triage/enumerate.js';
import { readExclusionIndex } from '../passes/contacts-triage/exclusions.js';
import { readSuppressionIndex } from '../passes/contacts-triage/suppression.js';
import {
  blockedByReason,
  selectMintCandidates,
  type MintBlockReason,
} from '../passes/contacts-mint/candidates.js';
import { computeNextBhcId, projectSerialIds } from '../passes/contacts-mint/ids.js';
import { planBatch } from '../passes/contacts-mint/plan.js';

/** Contacts_Triage_Queue: A attio_record_id, Y duplicate_status, AA classification. */
const Q_RECORD_ID = 0;
const Q_DUPLICATE_STATUS = 24;
const Q_DUPLICATE_CLASSIFICATION = 26;

const rule = (s: string) => `\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger();

  const attio = new AttioClient({
    apiKey: env.ATTIO_API_KEY,
    baseUrl: env.ATTIO_API_BASE,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  attio retry ${attempt} in ${delayMs}ms`),
  });

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });

  const runDate = new Date().toISOString().slice(0, 10);

  // ── Read both systems ─────────────────────────────────────────────────────
  const [masterRows, exclusionRows, queueRows] = await Promise.all([
    sheets.read(RANGES.masterId),
    sheets.read(TRIAGE_RANGES.exclusionsData),
    sheets.read(TRIAGE_RANGES.queueData),
  ]);
  const enumeration = await enumerateUnbridged(attio, logger);

  // ── CLAUSE 1 ──────────────────────────────────────────────────────────────
  const masterIdValues = masterRows.map((r) => cell(r, 0));
  const attioBhcIds: string[] = [];
  for (const rec of enumeration.recordsById.values()) {
    const v = rec.values?.['bhc_contact_id'];
    const first = Array.isArray(v) ? (v[0] as { value?: unknown } | undefined) : undefined;
    const s = String(first?.value ?? '').trim();
    if (s !== '') attioBhcIds.push(s);
  }
  const next = computeNextBhcId(masterIdValues, attioBhcIds);

  console.log(rule('CLAUSE 1 — maximum BHC_ID across BOTH systems'));
  console.log(`  Master_ID   max : ${next.masterMax === null ? '(none)' : `BHC-${String(next.masterMax).padStart(5, '0')}`}  (${masterIdValues.filter((v) => v.trim() !== '').length} ids)`);
  console.log(`  Attio       max : ${next.attioMax === null ? '(none)' : `BHC-${String(next.attioMax).padStart(5, '0')}`}  (${attioBhcIds.length} of ${enumeration.totalPeople} people carry one)`);
  console.log(`  HELD BY         : ${next.holder.toUpperCase()}`);
  console.log(`  NEXT BHC_ID     : ${next.nextId}`);
  console.log(`  Master_ID alone would allocate: ${next.masterOnlyWouldBe}${next.wouldHaveCollided ? '   ⚠ COLLIDES WITH A LIVE ATTIO ID' : '   (same — the systems agree today)'}`);
  if (next.malformed.length > 0) console.log(`  ⚠ malformed id values (${next.malformed.length}): ${next.malformed.slice(0, 8).join(', ')}`);

  // ── Selection ─────────────────────────────────────────────────────────────
  const duplicateFlagged = new Set<string>();
  for (const row of queueRows) {
    const id = cell(row, Q_RECORD_ID);
    const cls = cell(row, Q_DUPLICATE_CLASSIFICATION);
    const status = cell(row, Q_DUPLICATE_STATUS).toLowerCase();
    // An unresolved flag blocks a mint. A resolved one does not — a pair ruled
    // "different people" is mintable again, which is why this reads the status
    // rather than merely the presence of a classification.
    if (id !== '' && cls !== '' && (status === '' || status === 'pending')) duplicateFlagged.add(id);
  }

  const bridged = new Map<string, string>();
  for (const [id, rec] of enumeration.recordsById) {
    const v = rec.values?.['bhc_contact_id'];
    const first = Array.isArray(v) ? (v[0] as { value?: unknown } | undefined) : undefined;
    const s = String(first?.value ?? '').trim();
    if (s !== '') bridged.set(id, s);
  }

  const selection = selectMintCandidates({
    contacts: enumeration.unbridged,
    suppression: readSuppressionIndex(masterRows),
    exclusions: readExclusionIndex(exclusionRows),
    duplicateFlagged,
    bridged,
    runDate,
  });

  const counts = blockedByReason(selection.blocked);
  console.log(rule('POPULATION'));
  console.log(`  ${enumeration.totalPeople} Attio people · ${enumeration.unbridged.length} unbridged`);
  for (const k of Object.keys(counts) as MintBlockReason[]) {
    console.log(`    − ${String(counts[k]).padStart(4)}  ${k}`);
  }
  console.log(`  = ${selection.candidates.length} MINT CANDIDATES`);
  console.log(`  (accounted: ${selection.candidates.length + selection.blocked.length} of ${enumeration.unbridged.length})`);

  console.log(rule('BLOCKED — every one, with its justification'));
  for (const b of selection.blocked) {
    console.log(`  [${b.reason}] ${b.contact.name ?? '(no name)'} <${b.contact.primaryEmail ?? '—'}>`);
    console.log(`      ${b.detail}`);
  }

  console.log(rule('CANDIDATES'));
  for (const [i, c] of selection.candidates.entries()) {
    const k = c.contact;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${k.name} <${k.primaryEmail ?? k.allEmails[0] ?? '—'}>`
      + `  strength=${k.strengthLabel ?? 'none'}  first=${k.firstInteractionAt ?? '—'}  last=${k.lastInteractionAt ?? '—'}`,
    );
  }

  // ── The plan ──────────────────────────────────────────────────────────────
  const ids = projectSerialIds(next, selection.candidates.length);
  const plans = planBatch(selection.candidates, ids);

  console.log(rule('DRY RUN — exactly what WOULD be written, in order'));
  for (const p of plans) {
    console.log(`\n  ── ${p.bhcId}  ${p.fullName} <${p.email}>  record ${p.attioRecordId}`);
    for (const s of p.steps) {
      const what = s.system === 'master-id'
        ? `${s.kind.toUpperCase()} ${s.range}${s.values ? `  ${JSON.stringify(s.values)}` : ''}`
        : `${s.kind.toUpperCase()} person/${s.recordId}  ${s.field} = ${s.value}`;
      console.log(`     ${s.order}. [${s.system}] ${what}`);
      console.log(`        ↳ ${s.assertion}`);
    }
  }

  console.log(rule('NOTHING WAS WRITTEN'));
  console.log('  This entry point has no write path. The ids above are a SERIAL PROJECTION:');
  console.log('  a live mint must re-read the max across both systems before each one.');
  console.log('  The first live write to the identity bridge is ONE mint, confirmed by Bobby,');
  console.log('  read back from both systems before a second is considered.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
