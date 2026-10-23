/**
 * The link worklet: runs in Holepunch's Bare runtime on the phone (react-native-bare-kit), so
 * hyperdht, its native UDP and sodium run unchanged. It holds the one Noise stream to your Mac
 * (src/companion/client.ts: pairing, hello/welcome, keepalive, calls, files) and speaks to the
 * app's screens over BareKit.IPC in the RPC of lib/link/rpc.ts.
 *
 * To the screens it looks exactly like the protocol (MacFrames in, PhoneFrames out), so the app's
 * store is the same for the real Mac and the demo one. Battery: the DHT node exists only while a
 * link or a pairing needs it; `close` destroys it (no UDP, no keepalives, no wakeups).
 *
 * Bundled with bare-pack (npm run worklet:bundle); typechecked by npm run typecheck:worklet.
 */
import b4a from 'b4a';
import DHT from 'hyperdht';
import { CompanionClient, pairDevice } from '../../../src/companion/client';
import { deviceKeys, fromHex, hex, newSeed } from '../../../src/companion/device-crypto';
import { KEEPALIVE_MS, type MacFrame, type PhoneFrame } from '../../../src/companion/protocol';
import { encodeLine, lineDecoder, type UiToWorklet, type WorkletToUi } from '../lib/link/rpc';

declare const BareKit: { readonly IPC: { on(event: 'data', fn: (data: Uint8Array) => void): void; write(data: string | Uint8Array): void } };

const APP = 'beluga-companion/0.1.0';
const ipc = BareKit.IPC;
const post = (msg: WorkletToUi): void => void ipc.write(encodeLine(msg));
const frame = (f: MacFrame): void => post({ ev: 'frame', json: JSON.stringify(f) });
const log = (line: string): void => post({ ev: 'log', line });

let node: DHT | undefined;
let client: CompanionClient | undefined;
const pairings = new Set<number>();
/** Files coming from the screens, by `put` id, until their last piece. */
const puts = new Map<number, Uint8Array[]>();

const dht = (): DHT => (node ??= new DHT());

/** Nothing needs the network: the DHT node goes, and with it every socket and timer. */
async function quiet(): Promise<void> {
  if (client || pairings.size || !node) return;
  const n = node;
  node = undefined;
  await n.destroy().catch(() => undefined);
}

function open(msg: Extract<UiToWorklet, { op: 'open' }>): void {
  client?.close();
  const hello = JSON.parse(msg.hello) as Extract<PhoneFrame, { t: 'hello' }>;
  const keys = deviceKeys(fromHex(msg.secret.seed));
  const c = new CompanionClient({ node: dht(), address: msg.pairing.address, link: keys.link, app: APP, platform: hello.platform, topics: hello.topics, keepAliveMs: KEEPALIVE_MS });
  client = c;
  c.on('view', (topic, data, rev) => frame({ t: 'view', topic, rev, data }));
  c.on('nudge', (f) => frame(f));
  c.on('close', (code, reason) => {
    if (client !== c) return;
    client = undefined;
    // 4010: this phone was removed on the Mac. 4002: versions don't match.
    post({ ev: 'phase', phase: code === 4010 ? 'refused' : 'closed', detail: reason || undefined });
    void quiet();
  });
  post({ ev: 'phase', phase: 'dialing' });
  c.connect().then(
    (w) => {
      post({ ev: 'phase', phase: 'open' });
      frame({ t: 'welcome', v: { ...w.v }, min: { ...w.v }, mac: w.mac, me: w.me });
    },
    (e: Error) => {
      if (client === c) client = undefined;
      const update = /^Update /.test(e.message);
      post({ ev: 'phase', phase: update ? 'refused' : 'unreachable', detail: e.message });
      void quiet();
    },
  );
}

function onFrame(json: string): void {
  const c = client;
  if (!c) return;
  const f = JSON.parse(json) as PhoneFrame;
  switch (f.t) {
    case 'sub':
      return c.sub(f.topics);
    case 'call':
      c.call(f.method, f.args).then(
        (value) => frame({ t: 'result', id: f.id, ok: true, value }),
        (e: Error) => frame({ t: 'result', id: f.id, ok: false, error: e.message.slice(0, 2000) }),
      );
      return;
    case 'get':
      c.get(f.ref, f.variant, f.off).then(
        (piece) => frame({ t: 'chunk', id: f.id, off: piece.off, b64: b4a.toString(piece.bytes, 'base64'), eof: piece.eof, size: piece.size, mime: piece.mime }),
        (e: Error) => frame({ t: 'result', id: f.id, ok: false, error: e.message.slice(0, 2000) }),
      );
      return;
    case 'put': {
      // The screens send a file piece by piece (as the protocol does); the client sends it whole
      // with its own pieces (client.put), so collect, answer each piece, and put on the last.
      const got = puts.get(f.id) ?? [];
      got.push(b4a.from(f.b64, 'base64'));
      puts.set(f.id, got);
      if (!f.eof) return frame({ t: 'result', id: f.id, ok: true, value: { received: f.off + got.at(-1)!.length } });
      puts.delete(f.id);
      c.put(f.name, f.mime, b4a.concat(got)).then(
        (ref) => frame({ t: 'result', id: f.id, ok: true, value: { ref } }),
        (e: Error) => frame({ t: 'result', id: f.id, ok: false, error: e.message.slice(0, 2000) }),
      );
      return;
    }
    case 'focus':
      return c.focus(f.on);
    case 'push':
      return c.registerPush(f.platform, f.token, f.relayKey);
    case 'bye':
      return c.bye();
    default:
      return;
  }
}

function pair(msg: Extract<UiToWorklet, { op: 'pair' }>): void {
  const seed = msg.secret?.seed ?? hex(newSeed());
  const keys = deviceKeys(fromHex(seed));
  pairings.add(msg.id);
  pairDevice(dht(), msg.link ?? msg.code ?? '', { keys, name: msg.name, platform: msg.platform, app: APP }, { onWait: (fingerprint) => pairings.has(msg.id) && post({ ev: 'pair.wait', id: msg.id, fingerprint, secret: { seed } }) })
    .then(
      (p) => pairings.has(msg.id) && post({ ev: 'pair.ok', id: msg.id, pairing: { cert: p.cert, address: p.address, macName: p.macName }, secret: { seed } }),
      (e: Error) => pairings.has(msg.id) && post({ ev: 'pair.fail', id: msg.id, reason: e.message }),
    )
    .finally(() => {
      pairings.delete(msg.id);
      void quiet();
    });
}

ipc.on(
  'data',
  lineDecoder((line) => {
    let msg: UiToWorklet;
    try {
      msg = JSON.parse(line) as UiToWorklet;
    } catch {
      return;
    }
    try {
      switch (msg.op) {
        case 'open':
          return open(msg);
        case 'frame':
          return onFrame(msg.json);
        case 'close':
          puts.clear();
          client?.bye();
          client?.close();
          client = undefined;
          post({ ev: 'phase', phase: 'closed', detail: msg.reason });
          void quiet();
          return;
        case 'pair':
          return pair(msg);
        case 'pair.cancel':
          pairings.delete(msg.id);
          void quiet();
          return;
      }
    } catch (e) {
      log(`error: ${(e as Error).message}`);
    }
  }),
);

post({ ev: 'ready', version: APP });
