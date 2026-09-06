/** The QC report. Every rule reports its result, including the ones that passed. */

import type { QcReport } from './index.js';

export function renderQcReport(r: QcReport): string {
  const out: string[] = ['', '='.repeat(100), `DOCUMENTS QC — ${r.runId}  (READ-ONLY)`, '='.repeat(100)];
  if (r.aborted) return [...out, '', `ABORTED — ${r.abortReason}`, ''].join('\n');

  out.push('', 'DOCUMENTS READ');
  for (const d of r.documentsRead) {
    out.push(`  ${d.label.padEnd(34)} ${String(d.chars).padStart(7)} chars · ${String(d.headings).padStart(3)} headings · ${d.preReadMs}ms`);
  }
  out.push(`  writes issued: ${r.writesIssued}${r.writesIssued === 0 ? '  ✓ read-only' : '  ⚠ THIS PASS MUST NOT WRITE'}`);

  const order = { finding: 0, hygiene: 1, gap: 2 } as const;
  const sorted = [...r.results].sort((a, b) => order[a.severity] - order[b.severity] || a.ruleId.localeCompare(b.ruleId));

  for (const sev of ['finding', 'hygiene', 'gap'] as const) {
    const group = sorted.filter((x) => x.severity === sev);
    if (group.length === 0) continue;
    out.push('', sev === 'finding' ? 'RULES — findings' : sev === 'hygiene' ? 'RULES — hygiene (surfaced, not defects)' : 'RULES — coverage gaps (expected, reported by name)');
    for (const res of group) {
      const mark = !res.fired ? '✓ PASS' : sev === 'finding' ? '✗ FIRED' : '· ' + String(res.findings.length);
      out.push('', `  ${mark}  ${res.ruleId}   [${res.document}]`);
      out.push(`         ${res.statement}`);
      // A passing rule says what it measured — silence is not evidence.
      out.push(`         measured: ${res.measured}`);
      if (res.fired) {
        const show = res.findings.slice(0, sev === 'gap' ? 40 : 25);
        for (const f of show) out.push(`         → ${f.line ? `line ${f.line}: ` : ''}${f.detail}`);
        if (res.findings.length > show.length) out.push(`         → …and ${res.findings.length - show.length} more`);
        out.push(`         earned by: ${res.earnedBy.slice(0, 240)}`);
      }
    }
  }

  if (r.warnings.length > 0) {
    out.push('', 'WARNINGS:');
    for (const w of r.warnings) out.push(`  ⚠ ${w}`);
  }
  out.push('');
  return out.join('\n');
}
