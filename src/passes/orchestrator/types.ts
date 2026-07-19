import type { Pass0Report } from '../pass0/types.js';
import type { Pass1Report } from '../pass1/types.js';
import type { Pass2Report } from '../pass2/index.js';
import type { Pass25Report } from '../pass2_5/types.js';
import type { Pass3Report } from '../pass3/types.js';
import type { Pass4Report } from '../pass4/types.js';
import type { Pass45Report } from '../pass4_5/types.js';
import type { Pass5Report } from '../pass5/types.js';

export interface LateEditionOptions {
  readonly dryRun: boolean;
  readonly timezone: string;
  /** Cap per-pass processing where supported (PASS 2, 2.5, 4, 4.5) — for a fast smoke test, not in spec. */
  readonly limit?: number;
}

export interface LateEditionReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;

  readonly pass0: Pass0Report;
  readonly pass1: Pass1Report;
  readonly pass2: Pass2Report;
  readonly pass25: Pass25Report;
  readonly pass3: Pass3Report;
  readonly pass4: Pass4Report;
  readonly pass45: Pass45Report;
  readonly pass5: Pass5Report;
}
