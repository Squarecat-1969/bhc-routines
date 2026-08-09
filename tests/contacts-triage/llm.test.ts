import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../../src/lib/anthropic.js';
import { applyClamp, scoreWithLlm } from '../../src/passes/contacts-triage/llm.js';
import { parseTriageVerdict } from '../../src/passes/contacts-triage/llm-schema.js';
import { buildTriageUserPrompt, TRIAGE_SYSTEM_PROMPT } from '../../src/passes/contacts-triage/llm-prompt.js';
import { scoreContact } from '../../src/passes/contacts-triage/score.js';
import { countByDomain, deriveSignals } from '../../src/passes/contacts-triage/signals.js';
import { withStrength } from './fixtures.js';
import { FakeAnthropicBackend } from '../helpers/fake-anthropic.js';

const CONTACT = withStrength('Good', {
  name: 'Jane Doe',
  primaryEmail: 'jane@dcsg.com',
  allEmails: ['jane@dcsg.com'],
  company: 'DCSG',
  jobTitle: 'Marketing Manager',
  firstInteractionAt: '2026-01-01',
  lastInteractionAt: '2026-06-01',
  lastInteractionSubject: 'Q1 campaign brief',
  lastMeetingSummary: 'Bobby and Jane discussed the Q1 campaign scope.',
});

const SIGNALS = deriveSignals({ contact: CONTACT, domainCounts: countByDomain([CONTACT]) });
const DETERMINISTIC = scoreContact(SIGNALS);

describe('OVERRIDE WITH CLAMP', () => {
  it('lets the model override inside the +/-30 window', () => {
    expect(applyClamp(50, 70)).toEqual({ final: 70, clamped: false });
    expect(applyClamp(50, 20)).toEqual({ final: 20, clamped: false });
  });

  it('a 32 cannot become a 95', () => {
    expect(applyClamp(32, 95)).toEqual({ final: 62, clamped: true });
  });

  it('clamps downward disagreement too', () => {
    expect(applyClamp(80, 5)).toEqual({ final: 50, clamped: true });
  });

  it('respects the 0-100 floor and ceiling', () => {
    expect(applyClamp(10, 100)).toEqual({ final: 40, clamped: true });
    expect(applyClamp(95, 100)).toEqual({ final: 100, clamped: false });
    expect(applyClamp(5, 0)).toEqual({ final: 0, clamped: false });
  });

  it('is exact at the boundary — 30 points is not a clamp', () => {
    expect(applyClamp(50, 80)).toEqual({ final: 80, clamped: false });
    expect(applyClamp(50, 81)).toEqual({ final: 80, clamped: true });
  });
});

describe('response contract', () => {
  it('accepts the documented shape', () => {
    const parsed = parseTriageVerdict('{"score": 72, "reason": "Client-side marketing manager on an active brief."}');
    expect(parsed).toEqual({
      ok: true,
      value: { score: 72, reason: 'Client-side marketing manager on an active brief.' },
    });
  });

  it('tolerates a ```json fence', () => {
    const parsed = parseTriageVerdict('```json\n{"score": 10, "reason": "Order confirmations only."}\n```');
    expect(parsed.ok).toBe(true);
  });

  it('rejects an out-of-range score rather than clamping garbage into the queue', () => {
    expect(parseTriageVerdict('{"score": 140, "reason": "x"}').ok).toBe(false);
    expect(parseTriageVerdict('{"score": -5, "reason": "x"}').ok).toBe(false);
  });

  it('rejects a missing reason and non-JSON', () => {
    expect(parseTriageVerdict('{"score": 50}').ok).toBe(false);
    expect(parseTriageVerdict('I think this is a keeper.').ok).toBe(false);
  });

  it('collapses a rambling reason to one line', () => {
    const parsed = parseTriageVerdict(`{"score": 50, "reason": "Line one.\\nLine two."}`);
    expect(parsed.ok && parsed.value.reason).toBe('Line one. Line two.');
  });
});

describe('the prompt', () => {
  it('carries what deterministic scoring cannot read — subjects and summaries', () => {
    const prompt = buildTriageUserPrompt(CONTACT, SIGNALS, DETERMINISTIC);
    expect(prompt).toContain('Q1 campaign brief');
    expect(prompt).toContain('Bobby and Jane discussed the Q1 campaign scope.');
    expect(prompt).toContain('Marketing Manager');
  });

  it('passes the deterministic score AS CONTEXT, explicitly disputable', () => {
    const prompt = buildTriageUserPrompt(CONTACT, SIGNALS, DETERMINISTIC);
    expect(prompt).toContain(`deterministic score: ${DETERMINISTIC.score}/100`);
    expect(prompt).toContain('you may disagree with it');
  });

  it('asks exactly one question, in criteria-based language', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('worth tracking in a business CRM');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('the only question');
    // No persuasion-flavoured framing — that is what produced Late Edition's
    // self-refusals on scheduled runs.
    expect(TRIAGE_SYSTEM_PROMPT).not.toMatch(/you are authorized|please help|it is important that you/i);
  });

  it('names the life-admin boundary the spec calls out', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('mortgage broker');
  });

  it('carries the connection strength, which is Attio\'s own mailbox analysis', () => {
    const prompt = buildTriageUserPrompt(CONTACT, SIGNALS, DETERMINISTIC);
    expect(prompt).toContain('Attio connection strength: Good');
  });

  it('says plainly when there is no readable evidence, rather than padding', () => {
    const bare = withStrength('Weak', { name: 'Bare Record', lastInteractionSubject: null, lastMeetingSummary: null });
    const signals = deriveSignals({ contact: bare, domainCounts: countByDomain([bare]) });
    const prompt = buildTriageUserPrompt(bare, signals, scoreContact(signals));
    expect(prompt).toContain('(none on the record)');
  });
});

describe('scoreWithLlm — one contact never fails the run', () => {
  it('returns a clamped verdict and keeps the raw score for tuning', async () => {
    const fake = new FakeAnthropicBackend({ responseText: '{"score": 100, "reason": "Strong client relationship."}' });
    const { baseUrl } = await fake.start();
    try {
      const client = new AnthropicClient({ apiKey: 'test', baseUrl });
      const outcome = await scoreWithLlm(client, {
        contact: CONTACT,
        signals: SIGNALS,
        deterministic: { ...DETERMINISTIC, score: 40 },
      });
      expect(outcome.rawScore).toBe(100);
      expect(outcome.verdict?.score).toBe(70);
      expect(outcome.clamped).toBe(true);
      expect(outcome.error).toBeNull();
    } finally {
      await fake.stop();
    }
  });

  it('returns an error outcome, not a throw, when the API fails', async () => {
    const fake = new FakeAnthropicBackend({ responseText: '', failWith: 500 });
    const { baseUrl } = await fake.start();
    try {
      const client = new AnthropicClient({ apiKey: 'test', baseUrl, onRetry: () => {} });
      const outcome = await scoreWithLlm(client, {
        contact: CONTACT,
        signals: SIGNALS,
        deterministic: DETERMINISTIC,
      });
      expect(outcome.verdict).toBeNull();
      expect(outcome.error).toContain('Anthropic call failed');
    } finally {
      await fake.stop();
    }
  }, 15_000);

  it('returns an error outcome on unparseable output', async () => {
    const fake = new FakeAnthropicBackend({ responseText: 'Definitely a keeper!' });
    const { baseUrl } = await fake.start();
    try {
      const client = new AnthropicClient({ apiKey: 'test', baseUrl });
      const outcome = await scoreWithLlm(client, {
        contact: CONTACT,
        signals: SIGNALS,
        deterministic: DETERMINISTIC,
      });
      expect(outcome.verdict).toBeNull();
      expect(outcome.error).toContain('response validation failed');
    } finally {
      await fake.stop();
    }
  });

  it('sends exactly one message, with no tools — a narrow call, not a loop', async () => {
    const fake = new FakeAnthropicBackend({ responseText: '{"score": 55, "reason": "Ambiguous."}' });
    const { baseUrl } = await fake.start();
    try {
      const client = new AnthropicClient({ apiKey: 'test', baseUrl });
      await scoreWithLlm(client, { contact: CONTACT, signals: SIGNALS, deterministic: DETERMINISTIC });
      expect(fake.requests).toHaveLength(1);
      const body = fake.requests[0] as { messages: unknown[]; tools?: unknown; system: string };
      expect(body.messages).toHaveLength(1);
      expect(body.tools).toBeUndefined();
      expect(body.system).toBe(TRIAGE_SYSTEM_PROMPT);
    } finally {
      await fake.stop();
    }
  });
});
