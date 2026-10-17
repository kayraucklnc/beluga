import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  type Frame,
  type MsgFrame,
  type PeerInfo,
  Profile,
  PROTOCOL_VERSION,
  parseFrame,
} from '../protocol.js';
import { type RoomKeys, newNonce, open, seal, verifyProof } from './crypto.js';

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
}

interface Conn {
  alive: boolean;
  readonly ws: WebSocket;
  readonly nonce: string;
  peer?: PeerInfo;
  tokens: number;
  lastRefill: number;
}

export interface Hub {
  readonly port: number;
  close(): Promise<void>;
}

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
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(frame));
  };

  const authed = (): Conn[] => [...conns].filter((c) => c.peer);
  const peerList = (): PeerInfo[] => authed().map((c) => c.peer as PeerInfo);

  const broadcastPeers = (): void => {
    const box = seal(opts.keys, peerList());
    for (const c of authed()) send(c, { t: 'peers', box });
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
    if (!verifyProof(opts.keys, conn.nonce, frame.peerId, frame.proof)) {
      send(conn, { t: 'error', message: 'Authentication failed: wrong invite secret' });
      conn.ws.close(4001, 'auth');
      return;
    }
    const profile = Profile.safeParse(open(opts.keys, frame.box));
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
    const peer: PeerInfo = { ...profile.data, name: uniqueName(profile.data.name), peerId: frame.peerId };
    conn.peer = peer;
    send(conn, { t: 'welcome', you: peer, box: seal(opts.keys, { room: opts.roomName, peers: peerList(), history }) });
    broadcastPeers();
  };

  const relay = (conn: Conn, frame: MsgFrame): void => {
    const from = conn.peer?.peerId as string;
    const out: MsgFrame = { t: 'msg', from, ts: Date.now(), box: frame.box, ...(frame.to ? { to: frame.to } : {}) };
    if (frame.keep && !frame.to) remember(out);
    const targets = frame.to ? authed().filter((c) => c.peer?.peerId === frame.to) : authed();
    for (const c of targets) send(c, out);
  };

  wss.on('connection', (ws) => {
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

    ws.on('message', (data) => {
      if (!allow(conn)) return;
      const raw = data.toString();
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
        const profile = Profile.safeParse(open(opts.keys, frame.box));
        if (profile.success && frame.peerId === conn.peer.peerId) {
          // Renames are allowed but stay unique within the room.
          const name = profile.data.name === conn.peer.name ? conn.peer.name : uniqueName(profile.data.name);
          conn.peer = { ...profile.data, name, peerId: conn.peer.peerId };
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
  });

  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
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
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const c of conns) c.ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
