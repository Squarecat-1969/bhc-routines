import { describe, expect, it } from 'vitest';

import { dateOf } from '../src/lib/attio.js';
import { PERSON_SLUGS } from '../src/config/constants.js';

describe('dateOf', () => {
  it('extracts the timestamp from a real interaction-typed last_interaction value', () => {
    // Shape confirmed from live --dump-shapes output on a real person record.
    const values = {
      [PERSON_SLUGS.lastInteractionAt]: [
        {
          interaction_type: 'email',
          interacted_at: '2026-04-27T21:26:55.000000000Z',
          attribute_type: 'interaction',
        },
      ],
    };
    expect(dateOf(values, PERSON_SLUGS.lastInteractionAt)).toBe('2026-04-27');
  });

  it('returns null when the slug is absent (the old last_interaction_at is empty)', () => {
    expect(dateOf({ last_interaction_at: [] }, PERSON_SLUGS.lastInteractionAt)).toBeNull();
    expect(dateOf({}, PERSON_SLUGS.lastInteractionAt)).toBeNull();
  });

  it('still accepts a plain date/timestamp value shape', () => {
    const values = { last_interaction: [{ value: '2026-04-27T21:26:55Z' }] };
    expect(dateOf(values, PERSON_SLUGS.lastInteractionAt)).toBe('2026-04-27');
  });
});
