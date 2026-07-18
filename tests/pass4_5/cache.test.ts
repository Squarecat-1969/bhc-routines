import { describe, expect, it } from 'vitest';

import { buildCacheRow, cacheRowToSheetRow, computePipelineStale } from '../../src/passes/pass4_5/cache.js';
import type { CivilDate } from '../../src/lib/dates.js';

describe('computePipelineStale', () => {
  it('is false when next_check_in_date is null (spec: bool(next_check_in_date and ...))', () => {
    expect(computePipelineStale(null, '2026-07-18' as CivilDate)).toBe(false);
  });

  it('is true when next_check_in_date is strictly before today', () => {
    expect(computePipelineStale('2026-07-01' as CivilDate, '2026-07-18' as CivilDate)).toBe(true);
  });

  it('is false when next_check_in_date is today or in the future', () => {
    expect(computePipelineStale('2026-07-18' as CivilDate, '2026-07-18' as CivilDate)).toBe(false);
    expect(computePipelineStale('2026-08-01' as CivilDate, '2026-07-18' as CivilDate)).toBe(false);
  });
});

describe('buildCacheRow / cacheRowToSheetRow', () => {
  const base = {
    bhcId: 'BHC-00103',
    attioRecordId: 'rec-1',
    name: 'Suzie Schofield',
    title: 'Creative Director',
    companyName: 'Suzie Schofield',
    email: 'suzie@example.com',
    linkedinUrl: 'https://linkedin.com/in/suzie',
    relationshipTier: 'Strategic' as const,
    linkedinSegment: 'S3',
    track: 'TNB' as const,
    stage: 'Stage 2 – Proposal',
    nextCheckInDate: '2026-10-15' as CivilDate,
    nextTouchModePlanned: 'Social' as const,
    followUpReason: 'Tier Strategic',
    today: '2026-07-18' as CivilDate,
    runId: 'LATE-EDITION-123',
    generatedAt: '2026-07-18T00:00:00.000Z',
  };

  it('hardcodes attioSegment to S1 regardless of input (spec 4.5b: never derived)', () => {
    const row = buildCacheRow(base);
    expect(row.attioSegment).toBe('S1');
  });

  it('computes pipelineStale from nextCheckInDate vs today', () => {
    const staleRow = buildCacheRow({ ...base, nextCheckInDate: '2026-01-01' as CivilDate });
    expect(staleRow.pipelineStale).toBe(true);

    const freshRow = buildCacheRow({ ...base, nextCheckInDate: '2026-12-01' as CivilDate });
    expect(freshRow.pipelineStale).toBe(false);
  });

  it('produces an 18-column row in the exact spec 4.5e order', () => {
    const row = buildCacheRow(base);
    const sheetRow = cacheRowToSheetRow(row);
    expect(sheetRow).toHaveLength(18);
    expect(sheetRow).toEqual([
      'BHC-00103',
      'rec-1',
      'Suzie Schofield',
      'Creative Director',
      'Suzie Schofield',
      'suzie@example.com',
      'https://linkedin.com/in/suzie',
      'Strategic',
      'S3',
      'S1',
      'TNB',
      'Stage 2 – Proposal',
      '2026-10-15',
      'Social',
      'Tier Strategic',
      false,
      'LATE-EDITION-123',
      '2026-07-18T00:00:00.000Z',
    ]);
  });

  it('renders null fields as empty strings, not "null" or "undefined"', () => {
    const row = buildCacheRow({
      ...base,
      title: null,
      companyName: null,
      email: null,
      linkedinUrl: null,
      relationshipTier: null,
      linkedinSegment: null,
      track: null,
      stage: null,
      nextCheckInDate: null,
      nextTouchModePlanned: null,
      followUpReason: null,
    });
    const sheetRow = cacheRowToSheetRow(row);
    // Everything except bhcId, attioRecordId, name, attioSegment, pipelineStale, runId, generatedAt should be ''
    expect(sheetRow[3]).toBe('');
    expect(sheetRow[6]).toBe('');
    expect(sheetRow[12]).toBe('');
    expect(sheetRow.every((v) => v !== null && v !== undefined)).toBe(true);
  });
});
