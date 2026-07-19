/**
 * Spec 3b: assemble digest_body. Spec 3c: the empty-body HARD GATE — three
 * distinct outcomes, not just "did it work":
 *   - at least one [n] block -> valid, normal digest
 *   - zero actionable (but the pass ran) -> all-clear message, not a failure
 *   - body ends up empty despite rows existing -> a real failure, alert
 *     instead of silently posting nothing (spec: "DO NOT POST A STUB")
 */

import type { CivilDate } from '../../lib/dates.js';
import { buildTaskReconciliationLine, type TaskReconciliationCounts } from './task-reconciliation-line.js';
import type { DigestBodyResult, DigestBrainCompleteRow } from './types.js';

const AIDA_FOOTER = '— Review in Aida <https://aida.hougham.us/briefing/emails|here>. —';

export function buildDigestBody(
  rows: readonly DigestBrainCompleteRow[],
  runId: string,
  today: CivilDate,
  taskCounts: TaskReconciliationCounts,
  driftNotes: readonly string[] = [],
): DigestBodyResult {
  const surfaced = rows.filter((r) => r.slackMessage !== '');
  const filtered = rows.filter((r) => r.slackMessage === '');

  const header = `Aida — ${runId} — ${today}`;
  const countLine = `${surfaced.length} surfaced · ${filtered.length} filtered as noise/internal`;
  const taskLine = buildTaskReconciliationLine(taskCounts);

  // Zero actionable — a legitimate, expected outcome, not a failure.
  if (surfaced.length === 0) {
    const lines = [header, countLine, '', 'Nothing needs your attention tonight. ✅', '', taskLine];
    if (filtered.length > 0) lines.push('', `Filtered as noise/internal: ${filtered.length} thread${filtered.length === 1 ? '' : 's'}`);
    const body = lines.join('\n');
    if (body.trim() === '') {
      return { kind: 'failure', reason: 'digest body assembly produced an empty string despite having rows to report — internal bug, not a real all-clear' };
    }
    return { kind: 'all_clear', body };
  }

  const numberedBlocks = surfaced.map((r, i) => `[${i + 1}] ${r.slackMessage.replace(/^\[\d+\]\s*/, '')}`);

  const lines = [header, countLine, '', ...numberedBlocks, '', taskLine];
  if (driftNotes.length > 0) {
    lines.push('', `⚠ Drift: ${driftNotes.join(' | ')}`);
  }
  if (filtered.length > 0) {
    lines.push('', `Filtered as noise/internal: ${filtered.length} thread${filtered.length === 1 ? '' : 's'}`);
  }
  lines.push('', AIDA_FOOTER);

  const body = lines.join('\n');

  // HARD GATE: rows were staged (surfaced.length > 0) but assembly somehow
  // produced nothing — a real internal failure, never post a stub.
  if (body.trim() === '') {
    return { kind: 'failure', reason: 'digest body assembly produced an empty string despite having surfaced rows' };
  }

  return { kind: 'valid', body, surfacedCount: surfaced.length, filteredCount: filtered.length };
}
