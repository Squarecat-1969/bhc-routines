/**
 * Spec 3b wants a "Drift alert if any" in the digest. Standalone, PASS 3 has
 * no way to recover this (see docs/pass3-notes.md) — PASS 2's identity-drift
 * detection only ever lives in that run's in-memory Pass2Report.warnings,
 * never persisted anywhere. Chaining both passes in one process (this
 * orchestrator) is exactly the fix: pull the drift-specific warnings
 * straight out of PASS 2's report and hand them to PASS 3 directly.
 */

import type { Pass2Report } from '../pass2/index.js';

export function extractDriftNotes(pass2Report: Pass2Report): readonly string[] {
  return pass2Report.warnings.filter((w) => w.includes('identity drift'));
}
