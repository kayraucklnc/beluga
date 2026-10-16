import { z } from 'zod';

const PREFIX = 'klaude:';

const InvitePayload = z.object({
  url: z.string().regex(/^wss?:\/\/[^\s]+$/),
  secret: z.string().min(16).max(256),
  room: z.string().max(64).optional(),
});
export type Invite = z.infer<typeof InvitePayload>;

export function encodeInvite(invite: Invite): string {
  return PREFIX + Buffer.from(JSON.stringify(InvitePayload.parse(invite)), 'utf8').toString('base64url');
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('Invite codes start with "klaude:"');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invite code is corrupted');
  }
  const parsed = InvitePayload.safeParse(json);
  if (!parsed.success) throw new Error('Invite code is invalid');
  return parsed.data;
}

/** Convert an http(s) tunnel URL into the websocket URL peers dial. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/$/, '');
}
