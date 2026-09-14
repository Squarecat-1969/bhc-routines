/**
 * THE EMAIL CONTRACT, ENFORCED.
 *
 * Replays the sequences measured against live Attio on 2026-09-13
 * (tests/fixtures/attio-email-contract.ts) through:
 *   1. the shared contract model both fakes use, and
 *   2. the HTTP fake backend, over real HTTP, through the real AttioClient —
 *      so a fake that routes a verb to the wrong semantics fails here even if
 *      the model itself is right.
 *
 * If this fails, the fake has drifted from what Attio actually did. Fix the
 * fake. Change the fixture only after re-measuring live Attio.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AttioClient, emailsOf } from '../src/lib/attio.js';
import { AttioEmailModel, AttioUniquenessConflict } from './helpers/attio-email-model.js';
import { FakeBackend, type FakeBackendConfig } from './helpers/fake-backend.js';
import { MEASURED_CONFLICT, MEASURED_ONE_RECORD, addr, letters } from './fixtures/attio-email-contract.js';

describe('the contract model replays what live Attio did', () => {
  it('one record, every measured PATCH and PUT step', () => {
    const m = new AttioEmailModel({ rec: MEASURED_ONE_RECORD.initial.map(addr) });
    for (const step of MEASURED_ONE_RECORD.steps) {
      m[step.op]('rec', step.send.map(addr));
      expect(letters(m.read('rec')), step.label).toEqual(step.expect);
    }
  });

  it('a cross-record conflict is rejected with the real 400 and stores NOTHING, for PATCH and PUT', () => {
    for (const attempt of MEASURED_CONFLICT.attempts) {
      const m = new AttioEmailModel({ x: MEASURED_CONFLICT.x.map(addr), y: MEASURED_CONFLICT.y.map(addr) });
      let err: unknown;
      try { m[attempt.op]('y', attempt.sendToY.map(addr)); } catch (e) { err = e; }
      expect(err, attempt.op).toBeInstanceOf(AttioUniquenessConflict);
      expect((err as AttioUniquenessConflict).body.status_code).toBe(MEASURED_CONFLICT.expectStatus);
      expect((err as AttioUniquenessConflict).body.code).toBe(MEASURED_CONFLICT.expectCode);
      expect(letters(m.read('x'))).toEqual(MEASURED_CONFLICT.expectX);
      expect(letters(m.read('y'))).toEqual(MEASURED_CONFLICT.expectY);
    }
  });
});

describe('the HTTP fake backend honours the same contract, through the real AttioClient', () => {
  let backend: FakeBackend | null = null;
  afterEach(async () => { await backend?.stop(); backend = null; });

  async function clientFor(people: FakeBackendConfig['people']): Promise<AttioClient> {
    backend = new FakeBackend({ entries: [], people, masterId: [], contactsHeader: [], contacts: [] });
    const { attioBase } = await backend.start();
    return new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  }
  const stored = async (c: AttioClient, id: string) => letters(emailsOf((await c.getPersonRecord(id)).values, 'email_addresses'));

  it('PATCH via updatePersonRecord and PUT via replacePersonEmailAddresses reproduce every measured step', async () => {
    const c = await clientFor({ rec: { name: 'Scratch', emailAddresses: MEASURED_ONE_RECORD.initial.map(addr) } });
    for (const step of MEASURED_ONE_RECORD.steps) {
      if (step.op === 'patch') await c.updatePersonRecord('rec', { email_addresses: step.send.map(addr) });
      else await c.replacePersonEmailAddresses('rec', step.send.map(addr));
      expect(await stored(c, 'rec'), step.label).toEqual(step.expect);
    }
  });

  it('replacePersonEmailAddresses sends a PUT carrying ONLY email_addresses', async () => {
    const c = await clientFor({ rec: { name: 'Scratch', emailAddresses: ['a@example.test'] } });
    await c.replacePersonEmailAddresses('rec', ['b@example.test', 'a@example.test']);
    const puts = backend!.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(1);
    const values = (puts[0]!.body as { data: { values: Record<string, unknown> } }).data.values;
    expect(Object.keys(values)).toEqual(['email_addresses']);
  });

  it('a cross-record conflict surfaces as an error I1 can recognise, and stores nothing', async () => {
    const c = await clientFor({
      x: { name: 'X', emailAddresses: ['a@example.test'] },
      y: { name: 'Y', emailAddresses: ['c@example.test'] },
    });
    // I1 classifies a write rejection as email_unique_conflict by /uniqu/i on the
    // thrown error. If the client's error did not carry Attio's message, that
    // branch could never fire in production.
    await expect(c.replacePersonEmailAddresses('y', ['a@example.test', 'c@example.test'])).rejects.toThrow(/uniqu/i);
    expect(await stored(c, 'y')).toEqual(['C']);
    expect(await stored(c, 'x')).toEqual(['A']);
  });
});
