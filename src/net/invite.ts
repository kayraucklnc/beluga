import { z } from 'zod';

/** Direct dial addresses look like `p2p://<z-base-32 public key>`. */
export const P2P_SCHEME = 'p2p://';
const LEGACY_PREFIX = 'klaude:';
const DIRECT_PREFIX = 'klaud://';
const Z32_KEY = '[ybndrfg8ejkmcpqxot1uwisza345h769]{52}';
const WS_URL = /^wss?:\/\/[^\s#@]+$/;
const P2P_URL = new RegExp(`^p2p://${Z32_KEY}$`);
/** `klaud://<key>[?relay=<https url>]#<secret>`; the relay may be percent-encoded or not. */
const DIRECT_LINK = new RegExp(`^klaud://(${Z32_KEY})/?(?:\\?relay=([^\\s#]+))?#([\\w-]+)$`);
const DIRECT_IN_TEXT = new RegExp(`klaud://${Z32_KEY}/?(?:\\?relay=[^\\s#]+)?#[\\w-]{16,256}`);
const RELAY = /^(https?|wss?):\/\/([^\s#/@?]+)\/?$/;

const InvitePayload = z.object({
  /** `ws(s)://…` through a tunnel or LAN, or `p2p://<key>` straight to the host. */
  url: z.string().refine((u) => WS_URL.test(u) || P2P_URL.test(u)),
  /** For direct invites: the tunnel to fall back to when a direct connection can't be made. */
  relay: z.string().regex(WS_URL).optional(),
  secret: z.string().regex(/^[\w-]{16,256}$/),
  room: z.string().max(64).optional(),
});
export type Invite = z.infer<typeof InvitePayload>;

export const isDirect = (url: string): boolean => url.startsWith(P2P_SCHEME);

/** Convert an http(s) tunnel URL into the websocket URL peers dial. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/$/, '');
}

const toHttpUrl = (wsUrl: string): string => wsUrl.replace(/^ws(s?):\/\//, 'http$1://');

/**
 * Invites are plain links. Direct ones name the host's public key, e.g.
 * `klaud://yry…bo?relay=https://calm-river.trycloudflare.com#k3Jd…`; relay-only ones are
 * `https://calm-river.trycloudflare.com#k3Jd…`. The secret lives in the #fragment,
 * which browsers and proxies never send to servers (and the DHT never sees it).
 */
export function encodeInvite(invite: Invite): string {
  const valid = InvitePayload.parse(invite);
  if (!isDirect(valid.url)) return `${toHttpUrl(valid.url)}#${valid.secret}`;
  const relay = valid.relay ? `?relay=${toHttpUrl(valid.relay)}` : '';
  return `${DIRECT_PREFIX}${valid.url.slice(P2P_SCHEME.length)}${relay}#${valid.secret}`;
}

function relayUrl(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error('Invite code is invalid');
  }
  const m = RELAY.exec(decoded);
  if (!m) throw new Error('Invite code is invalid');
  return `${m[1] === 'https' || m[1] === 'wss' ? 'wss' : 'ws'}://${m[2]}`;
}

function decodeDirect(code: string): Invite {
  const m = DIRECT_LINK.exec(code);
  if (!m) throw new Error('That does not look like a klaud invite (expected klaud://…#secret)');
  const parsed = InvitePayload.safeParse({ url: `${P2P_SCHEME}${m[1]}`, ...(m[2] ? { relay: relayUrl(m[2]) } : {}), secret: m[3] });
  if (!parsed.success) throw new Error('Invite code is invalid');
  return parsed.data;
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (trimmed.startsWith(DIRECT_PREFIX)) return decodeDirect(trimmed);
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
  // First: a direct link's relay is itself an https URL followed by the secret.
  const direct = DIRECT_IN_TEXT.exec(text);
  if (direct) return direct[0];
  const link = /(https?|wss?):\/\/[^\s#/@]+\/?#[\w-]{16,256}/.exec(text);
  if (link) return link[0];
  return /klaude:[\w-]{20,}/.exec(text)?.[0];
}
