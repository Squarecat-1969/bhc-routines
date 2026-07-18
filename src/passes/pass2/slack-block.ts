/**
 * Spec 2g2: "Write per-thread Slack block to col AA for actionable rows
 * only:
 *   [n] {Contact_Name or "⚠ unresolved"} — {Subject}
 *   {Action_Required} | {one-line summary}
 *   {if REPLY_NEEDED: Draft: "{Response_Draft}"}"
 *
 * "Actionable" = not NO_ACTION — the spec's format shows a block for any
 * classified thread, with the REPLY_NEEDED draft line as the only truly
 * conditional part. NO_ACTION rows get no block (empty string), consistent
 * with them being noise/filtered content nobody needs to see in the digest.
 */

export interface SlackBlockInput {
  readonly index: number; // 1-based position in tonight's digest
  readonly contactName: string | null; // null when primary is unresolved
  readonly subject: string;
  readonly actionRequired: string;
  readonly oneLineSummary: string;
  readonly responseDraft: string; // only used when actionRequired === 'REPLY_NEEDED'
}

export function buildSlackBlock(input: SlackBlockInput): string {
  const name = input.contactName ?? '⚠ unresolved';
  const lines = [
    `[${input.index}] ${name} — ${input.subject}`,
    `${input.actionRequired} | ${input.oneLineSummary}`,
  ];
  if (input.actionRequired === 'REPLY_NEEDED' && input.responseDraft !== '') {
    lines.push(`Draft: "${input.responseDraft}"`);
  }
  return lines.join('\n');
}
