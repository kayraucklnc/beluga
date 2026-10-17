import { z } from 'zod';

const LEGACY_PREFIX = 'klaude:';

const InvitePayload = z.object({
  url: z.string().regex(/^wss?:\/\/[^\s#@]+$/),
  secret: z.string().regex(/^[\w-]{16,256}$/),
  room: z.string().max(64).optional(),
});
export type Invite = z.infer<typeof InvitePayload>;

/** Convert an http(s) tunnel URL into the websocket URL peers dial. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/$/, '');
}

const toHttpUrl = (wsUrl: string): string => wsUrl.replace(/^ws(s?):\/\//, 'http$1://');

/**
 * Invites are plain links, e.g. `https://calm-river.trycloudflare.com#k3Jd…`.
 * The secret lives in the #fragment, which browsers and proxies never send to servers.
 */
export function encodeInvite(invite: Invite): string {
  const valid = InvitePayload.parse(invite);
  return `${toHttpUrl(valid.url)}#${valid.secret}`;
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (trimmed.startsWith(LEGACY_PREFIX)) return decodeLegacy(trimmed);
  const m = /^(https?|wss?):\/\/([^\s#/@]+)\/?#([\w-]+)$/.exec(trimmed);
  if (!m) throw new Error('That does not look like a klaud invite (expected https://…#secret)');
  const scheme = m[1] === 'https' || m[1] === 'wss' ? 'wss' : 'ws';
  const parsed = InvitePayload.safeParse({ url: `${scheme}://${m[2]}`, secret: m[3] });
  if (!parsed.success) throw new Error('Invite code is invalid');
  return parsed.data;
}

function decodeLegacy(code: string): Invite {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(code.slice(LEGACY_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invite code is corrupted');
  }
  const parsed = InvitePayload.safeParse(json);
  if (!parsed.success) throw new Error('Invite code is invalid');
  return parsed.data;
}

/** Find an invite inside arbitrary pasted text (e.g. "klaud join https://…#abc"). */
export function findInvite(text: string): string | undefined {
  const link = /(https?|wss?):\/\/[^\s#/@]+\/?#[\w-]{16,256}/.exec(text);
  if (link) return link[0];
  return /klaude:[\w-]{20,}/.exec(text)?.[0];
}
