/**
 * Spec 2e: "AC Reply_Recipients_JSON (REPLY_NEEDED only): { "to": [...], "cc":
 * [...] } — STRIP all owned/internal addresses. AD Reply_Mode (REPLY_NEEDED
 * only): individual (1 external) or group (2+)." Computed deterministically
 * from already-resolved participants — not something the LLM needs to
 * generate, since we already have the real to/cc lists from resolution.
 */

export interface ReplyRecipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

export type ReplyMode = 'individual' | 'group';

export function computeReplyRecipients(primaryEmail: string, secondaryEmails: readonly string[]): ReplyRecipients {
  return { to: [primaryEmail], cc: secondaryEmails };
}

export function computeReplyMode(secondaryEmails: readonly string[]): ReplyMode {
  // "1 external" = just the primary, no secondaries copied in.
  return secondaryEmails.length === 0 ? 'individual' : 'group';
}
