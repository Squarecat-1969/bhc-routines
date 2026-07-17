import { z } from 'zod';

/**
 * Env is read once, validated, and passed explicitly. No module reads
 * `process.env` directly — that keeps secrets out of the pure layers and makes
 * every consumer testable without a live environment.
 */
const EnvSchema = z.object({
  BRAIN_API_TOKEN: z.string().min(1, 'BRAIN_API_TOKEN is required'),
  ATTIO_API_KEY: z.string().min(1, 'ATTIO_API_KEY is required'),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  RUN_TIMEZONE: z.string().min(1).default('UTC'),
  SHEETS_PROXY_URL: z.string().url().default('https://aida.hougham.us/api/brain/sheets'),
  ATTIO_API_BASE: z.string().url().default('https://api.attio.com/v2'),
});

export type Env = z.infer<typeof EnvSchema>;

function blankToUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t === '' ? undefined : t;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse({
    BRAIN_API_TOKEN: blankToUndefined(source.BRAIN_API_TOKEN),
    ATTIO_API_KEY: blankToUndefined(source.ATTIO_API_KEY),
    SLACK_WEBHOOK_URL: blankToUndefined(source.SLACK_WEBHOOK_URL),
    ANTHROPIC_API_KEY: blankToUndefined(source.ANTHROPIC_API_KEY),
    RUN_TIMEZONE: blankToUndefined(source.RUN_TIMEZONE),
    SHEETS_PROXY_URL: blankToUndefined(source.SHEETS_PROXY_URL),
    ATTIO_API_BASE: blankToUndefined(source.ATTIO_API_BASE),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}\n\nSee .env.example.`);
  }

  // Fail fast on a bad timezone rather than silently resolving the wrong "today".
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: parsed.data.RUN_TIMEZONE });
  } catch {
    throw new Error(`RUN_TIMEZONE is not a valid IANA timezone: ${parsed.data.RUN_TIMEZONE}`);
  }

  return parsed.data;
}
