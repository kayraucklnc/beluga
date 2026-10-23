import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  type Frame,
  type MsgFrame,
  type PeerInfo,
  Profile,
  PROTOCOL_VERSION,
  parseFrame,
} from '../protocol.js';
import { type RoomKeys, newNonce, open as openBox, seal, verifyNonce, verifyProof } from './crypto.js';
import { type P2POptions, type P2PServer, listenP2P } from './p2p.js';
import { isLate } from './patient-timer.js';
import { type MessageSocket, fromWebSocket } from './transport.js';

export interface HubOptions {
  readonly keys: RoomKeys;
  readonly port?: number;
  readonly host?: string;
  readonly maxPeers?: number;
  readonly historyLimit?: number;
  /** Messages per second allowed per connection before frames are dropped. */
  readonly rateLimit?: number;
  readonly authTimeoutMs?: number;
  /** Shown to everyone who joins. */
  readonly roomName?: string;
  /** The host's own peer id, marked `host` in the peer list. */
  readonly hostId?: string;
}

/** What a guest (someone who came in with a project link) may reach. */
export interface GuestAccess {
  /** Everything a member sees (the room chat, history, everyone's shares). */
  readonly full: boolean;
  /** Besides the host: people they may exchange messages with and see (e.g. others in their workspace). */
  readonly contacts: readonly string[];
}

/** Decides who may come in with a project link (the host's klaud keeps the links). */
export interface GuestGate {
  /** Keys of the links that work right now (each derived from its own secret). */
  keys(): ReadonlyArray<{ readonly id: string; readonly keys: RoomKeys }>;
  /** Someone proved they hold link `id`. Undefined turns them away; `closed`: the room takes no new people. */
  admit(id: string, peerId: string, closed: boolean): (GuestAccess & { readonly room?: string }) | undefined;
}

interface Conn {
  alive: boolean;
  readonly ws: MessageSocket;
  readonly nonce: string;
  peer?: PeerInfo;
  /** Came in with a project link: only reaches the host and `contacts`, unless `full`. */
  guest?: { full: boolean; contacts: Set<string> };
  tokens: number;
  lastRefill: number;
}

export interface Hub {
  readonly port: number;
  close(): Promise<void>;
  /** Disconnect someone for good. Call `replaceInvite` too, or they can come back with the old link. */
  kick(peerId: string): boolean;
  /**
   * Make a new invite secret the only way in. People already here get it (sealed with
   * the room key) so they can reconnect; anyone holding just the old link can't.
   */
  replaceInvite(secret: string, keys: RoomKeys): void;
  /** Closed rooms only let back in people who are already members. */
  setOpen(open: boolean): void;
  readonly isOpen: boolean;
  /** Forget the history shown to people who join later. */
  clearHistory(): void;
  /** Serve one more connection (any transport); it goes through the same auth and limits. */
  attach(socket: MessageSocket): void;
  /**
   * Also accept direct peer-to-peer connections. Resolves with the public key friends dial
   * once the host is announced on the DHT. Safe to call again (returns the same key).
   */
  listenP2P(opts?: P2POptions): Promise<string>;
  /** The direct-connection key, once listening. */
  readonly p2pKey: string | undefined;
  /** Accept project links (guests only see what they were invited to). */
  setGuestGate(gate: GuestGate | undefined): void;
  /** Change what a connected guest reaches (invited to more, or to the whole room). */
  setGuestAccess(peerId: string, access: GuestAccess): void;
  /** Close someone's connection with a reason (not a ban: a new link still works). */
  dismiss(peerId: string, message: string): boolean;
}

/** Close codes the client treats as final. */
export const REMOVED_CODE = 4010;
export const CLOSED_CODE = 4008;

const MAX_PAYLOAD = 1024 * 1024;
const MAX_PREAUTH_BYTES = 16 * 1024;
const MAX_PENDING_AUTH = 32;
/** Must stay well under the client's maxPayload since history ships inside `welcome`. */
const HISTORY_BYTES = 1536 * 1024;
const HEARTBEAT_MS = 25_000;

/**
 * The hub is a tiny relay that runs on the host's machine. It authenticates
 * peers with an HMAC challenge, relays end-to-end encrypted frames, and keeps
 * a short history so late joiners see the conversation.
 */
export function startHub(opts: HubOptions): Promise<Hub> {
  const maxPeers = opts.maxPeers ?? 16;
  const historyLimit = opts.historyLimit ?? 300;
  const rate = opts.rateLimit ?? 120;
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000;
  const conns = new Set<Conn>();
  const roomKeys = opts.keys;
  let inviteKeys = opts.keys;
  let inviteSecret: string | undefined;
  /** Invite keys that were replaced: only people already in the room may still use them (to reconnect). */
  let oldInviteKeys: RoomKeys[] = [];
  let open = true;
  /** People admitted to the room (and not removed): they may reconnect, even when it's closed or the link changed. */
  const members = new Set<string>();
  const removed = new Set<string>();
  let history: readonly MsgFrame[] = [];
  let historyBytes = 0;

  const remember = (frame: MsgFrame): void => {
    const size = frame.box.ct.length;
    history = [...history, frame];
    historyBytes += size;
    while (history.length > historyLimit || historyBytes > HISTORY_BYTES) {
      historyBytes -= history[0]?.box.ct.length ?? 0;
      history = history.slice(1);
    }
  };

  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1', maxPayload: MAX_PAYLOAD });

  const send = (conn: Conn, frame: Frame): void => {
    if (conn.ws.isOpen) conn.ws.send(JSON.stringify(frame));
  };

  const authed = (): Conn[] => [...conns].filter((c) => c.peer);
  const peerList = (): PeerInfo[] => authed().map((c) => c.peer as PeerInfo);
  let gate: GuestGate | undefined;
  const restricted = (c: Conn): boolean => Boolean(c.guest && !c.guest.full);

  /** Who a connection sees: everyone, or (for a guest) themselves, the host and their contacts, without anyone's shares. */
  const peersFor = (c: Conn): PeerInfo[] => {
    const all = peerList();
    const g = c.guest;
    if (!g || g.full) return all;
    const self = c.peer?.peerId;
    return all
      .filter((p) => p.peerId === self || p.host || g.contacts.has(p.peerId))
      .map((p) => (p.peerId === self ? p : { peerId: p.peerId, name: p.name, agent: p.agent, shares: [], ...(p.host ? { host: true } : {}), ...(p.guest ? { guest: true } : {}) }));
  };

  const broadcastPeers = (): void => {
    const box = seal(roomKeys, peerList());
    for (const c of authed()) send(c, { t: 'peers', box: restricted(c) ? seal(roomKeys, peersFor(c)) : box });
  };

  const uniqueName = (name: string): string => {
    const taken = new Set(peerList().map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name}-${i}`.slice(0, 32);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  };

  const allow = (conn: Conn): boolean => {
    const now = Date.now();
    conn.tokens = Math.min(rate, conn.tokens + ((now - conn.lastRefill) / 1000) * rate);
    conn.lastRefill = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  };

  const handleHello = (conn: Conn, frame: Extract<Frame, { t: 'hello' }>): void => {
    // The peer id must belong to whoever signs with its key; nobody can take someone else's.
    if (!verifyNonce(frame.pub, conn.nonce, frame.peerId, frame.sig)) {
      send(conn, { t: 'error', message: 'Authentication failed: bad identity' });
      conn.ws.close(4001, 'identity');
      return;
    }
    const current = verifyProof(inviteKeys, conn.nonce, frame.peerId, frame.proof);
    const returning = !current && members.has(frame.peerId) ? oldInviteKeys.find((k) => verifyProof(k, conn.nonce, frame.peerId, frame.proof)) : undefined;
    // Not the room link: maybe a project link (its own secret, so it never reveals the room's).
    const link = !current && !returning ? gate?.keys().find((k) => verifyProof(k.keys, conn.nonce, frame.peerId, frame.proof)) : undefined;
    if (!current && !returning && !link) {
      send(conn, { t: 'error', message: 'Authentication failed: this invite link no longer works' });
      conn.ws.close(4001, 'auth');
      return;
    }
    const helloKeys = returning ?? link?.keys ?? inviteKeys;
    if (removed.has(frame.peerId)) {
      send(conn, { t: 'error', message: 'You were removed from this room' });
      conn.ws.close(REMOVED_CODE, 'removed');
      return;
    }
    if (!link && !open && !members.has(frame.peerId) && frame.peerId !== opts.hostId) {
      send(conn, { t: 'error', message: "This room isn't taking new people right now" });
      conn.ws.close(CLOSED_CODE, 'closed');
      return;
    }
    const profile = Profile.safeParse(openBox(helloKeys, frame.box));
    if (!profile.success) {
      send(conn, { t: 'error', message: 'Invalid profile' });
      conn.ws.close(4002, 'profile');
      return;
    }
    if (authed().some((c) => c.peer?.peerId === frame.peerId)) {
      send(conn, { t: 'error', message: 'Peer id already connected' });
      conn.ws.close(4003, 'dup');
      return;
    }
    if (authed().length >= maxPeers) {
      send(conn, { t: 'error', message: 'Room is full' });
      conn.ws.close(4004, 'full');
      return;
    }
    // Last, so a single-use link is only used up by a join that actually happens.
    const admission = link ? gate?.admit(link.id, frame.peerId, !open) : undefined;
    if (link && !admission) {
      send(conn, { t: 'error', message: 'This link has expired, was already used, or was turned off. Ask for a new one' });
      conn.ws.close(4001, 'link');
      return;
    }
    const peer: PeerInfo = { ...profile.data, name: uniqueName(profile.data.name), peerId: frame.peerId, ...(frame.peerId === opts.hostId ? { host: true } : {}), ...(admission && !admission.full ? { guest: true } : {}) };
    conn.peer = peer;
    if (admission) conn.guest = { full: admission.full, contacts: new Set(admission.contacts) };
    // Guests reconnect with their link (the host's klaud decides); members may come back with an older room link.
    else members.add(frame.peerId);
    // The welcome is sealed with the invite's key and carries the room key, which differs once the invite was replaced.
    const roomKey = helloKeys === roomKeys ? {} : { roomKey: roomKeys.enc.toString('base64') };
    const fresh = returning && inviteSecret ? { secret: inviteSecret } : {};
    const room = admission?.room ?? opts.roomName;
    send(conn, { t: 'welcome', you: peer, box: seal(helloKeys, { room, ...roomKey, ...fresh, peers: peersFor(conn), history: restricted(conn) ? [] : history }) });
    broadcastPeers();
  };

  const relay = (conn: Conn, frame: MsgFrame): void => {
    const from = conn.peer?.peerId as string;
    const out: MsgFrame = { t: 'msg', from, ts: Date.now(), box: frame.box, ...(frame.to ? { to: frame.to } : {}), ...(frame.pub && frame.sig && frame.sts !== undefined ? { pub: frame.pub, sig: frame.sig, sts: frame.sts } : {}) };
    // A guest only talks to the host and their contacts, one person at a time.
    const g = conn.guest;
    if (g && !g.full && (!frame.to || !(frame.to === from || frame.to === opts.hostId || g.contacts.has(frame.to)))) return;
    // …and only hears what's addressed to them by those people (never broadcasts or history).
    const reaches = (c: Conn): boolean => !c.guest || c.guest.full || (Boolean(frame.to) && (from === c.peer?.peerId || from === opts.hostId || c.guest.contacts.has(from)));
    if (frame.keep && !frame.to && !restricted(conn)) remember(out);
    const targets = (frame.to ? authed().filter((c) => c.peer?.peerId === frame.to) : authed()).filter(reaches);
    for (const c of targets) send(c, out);
  };

  const attach = (ws: MessageSocket): void => {
    if ([...conns].filter((c) => !c.peer).length >= MAX_PENDING_AUTH) {
      ws.close(4006, 'busy');
      return;
    }
    const conn: Conn = { ws, alive: true, nonce: newNonce(), tokens: rate, lastRefill: Date.now() };
    ws.on('pong', () => (conn.alive = true));
    conns.add(conn);
    const timer = setTimeout(() => {
      if (!conn.peer) ws.close(4005, 'auth timeout');
    }, authTimeoutMs);

    ws.on('message', (raw) => {
      if (!allow(conn)) return;
      if (!conn.peer && raw.length > MAX_PREAUTH_BYTES) {
        ws.close(4007, 'too large');
        return;
      }
      const frame = parseFrame(raw);
      if (!frame) return;
      if (!conn.peer) {
        if (frame.t === 'hello') handleHello(conn, frame);
        return;
      }
      if (frame.t === 'msg') relay(conn, frame);
      if (frame.t === 'hello') {
        // Profile update (e.g. shares changed) from an already-authenticated peer.
        const profile = Profile.safeParse(openBox(roomKeys, frame.box));
        if (profile.success && frame.peerId === conn.peer.peerId) {
          // Renames are allowed but stay unique within the room.
          const name = profile.data.name === conn.peer.name ? conn.peer.name : uniqueName(profile.data.name);
          conn.peer = { ...profile.data, name, peerId: conn.peer.peerId, ...(conn.peer.host ? { host: true } : {}), ...(restricted(conn) ? { guest: true } : {}) };
          broadcastPeers();
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      const wasAuthed = Boolean(conn.peer);
      conns.delete(conn);
      if (wasAuthed) broadcastPeers();
    });
    ws.on('error', () => ws.close());

    send(conn, { t: 'challenge', v: PROTOCOL_VERSION, nonce: conn.nonce });
  };
  wss.on('connection', (ws) => attach(fromWebSocket(ws)));

  let p2p: Promise<P2PServer> | undefined;
  let p2pKey: string | undefined;
  let closing = false;
  const startP2P = (p2pOpts: P2POptions = {}): Promise<string> => {
    if (closing) return Promise.reject(new Error('The room is closing'));
    p2p ??= listenP2P({ ...p2pOpts, maxBytes: MAX_PAYLOAD, onSocket: attach });
    // A failed start can be retried later.
    p2p.catch(() => (p2p = undefined));
    return p2p.then((server) => (p2pKey = server.publicKey));
  };

  let lastBeat = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    // Stalled or asleep (the host's daemon runs this hub): pongs may be waiting to be read, so ask again.
    const late = isLate(now - lastBeat, HEARTBEAT_MS);
    lastBeat = now;
    for (const c of conns) {
      if (!c.alive && !late) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const { port } = wss.address() as AddressInfo;
      resolve({
        port,
        get isOpen() {
          return open;
        },
        kick: (peerId) => {
          if (peerId === opts.hostId) return false;
          removed.add(peerId);
          members.delete(peerId);
          const conn = authed().find((c) => c.peer?.peerId === peerId);
          if (!conn) return false;
          send(conn, { t: 'error', message: 'The host removed you from this room' });
          conn.ws.close(REMOVED_CODE, 'removed');
          return true;
        },
        replaceInvite: (secret, keys) => {
          oldInviteKeys = [...oldInviteKeys, inviteKeys].slice(-8);
          inviteKeys = keys;
          inviteSecret = secret;
          const box = seal(roomKeys, { secret });
          // Guests never get the room's link: theirs is their own.
          for (const c of authed()) if (!removed.has(c.peer?.peerId ?? '') && !c.guest) send(c, { t: 'rekey', box });
        },
        setOpen: (next) => {
          open = next;
        },
        clearHistory: () => {
          history = [];
          historyBytes = 0;
        },
        attach,
        dismiss: (peerId, message) => {
          const conn = authed().find((c) => c.peer?.peerId === peerId);
          if (!conn || peerId === opts.hostId) return false;
          send(conn, { t: 'error', message });
          conn.ws.close(CLOSED_CODE, 'dismissed');
          return true;
        },
        setGuestGate: (next) => {
          gate = next;
        },
        setGuestAccess: (peerId, access) => {
          const conn = authed().find((c) => c.peer?.peerId === peerId && c.guest);
          if (!conn) return;
          conn.guest = { full: access.full, contacts: new Set(access.contacts) };
          // Invited to everything: they're a member like anyone else (no longer marked as a guest).
          if (conn.peer) conn.peer = access.full ? { ...conn.peer, guest: undefined } : { ...conn.peer, guest: true };
          broadcastPeers();
        },
        listenP2P: startP2P,
        get p2pKey() {
          return p2pKey;
        },
        close: async () => {
          closing = true;
          clearInterval(heartbeat);
          for (const c of conns) c.ws.terminate();
          await Promise.all([new Promise<void>((done) => wss.close(() => done())), p2p?.then((server) => server.close()).catch(() => undefined)]);
        },
      });
    });
  });
}
