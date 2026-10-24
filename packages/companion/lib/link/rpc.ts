/**
 * What the app's screens and the link worklet (worklet/link.ts, a Bare runtime started by
 * react-native-bare-kit) say to each other over the worklet's IPC stream: one JSON object per line.
 *
 * The worklet owns everything network and crypto (hyperdht, secret-stream, sodium, the device's
 * keys while they're in use); the screens own what's shown. Frames to and from the Mac pass through
 * as the protocol's JSON (src/companion/protocol.ts), validated on the screens' side with zod, so
 * the worklet needs no zod and stays small.
 *
 * Kept free of React Native and of Bare: both sides import it.
 */

/** A paired Mac, as the phone keeps it (expo-secure-store). */
export interface Pairing {
  /** The device certificate the Mac signed (DeviceCert, as JSON). */
  readonly cert: unknown;
  /** The Mac's companion address (hex public key to dial). */
  readonly address: string;
  readonly macName: string;
  /** Your name on the Mac (the cert's owner's profile). */
  readonly me?: string;
  /** The Mac's relay when it paired (kept in LinkHints from then on). */
  readonly relay?: string;
}

/** The way that worked: hyperdht (LAN, then hole-punching) or the relay. */
export type Way = 'p2p' | 'relay';

/**
 * What the phone remembers about reaching its Mac (kv, not secret): the relay URLs it has seen,
 * newest first, and the way that worked last on each network (keyed by its local subnet).
 */
export interface LinkHints {
  readonly relays: readonly string[];
  readonly prefer: Readonly<Record<string, Way>>;
}

/** One dial attempt, and why nothing got through (src/companion/dial.ts DialReport). */
export interface Attempt {
  readonly way: Way;
  readonly outcome: 'ok' | 'timeout' | 'refused' | 'unreachable' | 'not-found' | 'failed' | 'skipped' | 'lost';
  readonly code?: string;
  readonly ms?: number;
}
export interface DialReportJson {
  readonly tried: readonly Attempt[];
  readonly dht: 'ok' | 'unreachable' | 'unknown';
  readonly found: 'yes' | 'no' | 'unknown';
  readonly recordAge?: number;
}
export type LinkPathName = 'lan' | 'direct' | 'relay';

/** The phone's own secret: the device key's seed (hex, 32 bytes). Lives in the secure store only. */
export interface DeviceSecret {
  readonly seed: string;
}

export type UiToWorklet =
  /** Dial the Mac and open the Noise stream. `hello` is sent by the worklet as the first frame. */
  | { readonly op: 'open'; readonly pairing: Pairing; readonly secret: DeviceSecret; readonly hello: string; readonly hints?: LinkHints }
  /** One PhoneFrame, already JSON. */
  | { readonly op: 'frame'; readonly json: string }
  /** Close the stream and destroy the DHT node (no UDP, no keepalives). */
  | { readonly op: 'close'; readonly reason: string }
  /** Pair with a Mac: the QR's link or the typed code. A secret is made by the worklet if none is given. */
  | { readonly op: 'pair'; readonly id: number; readonly link?: string; readonly code?: string; readonly name: string; readonly platform: 'android' | 'ios'; readonly secret?: DeviceSecret; readonly hints?: LinkHints }
  /** The relay's WebSocket, which the screens' side opens (React Native has one; Bare doesn't). */
  | { readonly op: 'ws.event'; readonly id: number; readonly kind: 'open' | 'message' | 'close'; readonly b64?: string; readonly code?: number }
  | { readonly op: 'pair.cancel'; readonly id: number }
  /** The loopback media server's base URL (started on first ask), for the video player (src/companion/media-stream.ts). */
  | { readonly op: 'media'; readonly id: number };

export type LinkPhase = 'dialing' | 'open' | 'closed' | 'unreachable' | 'refused';

export type WorkletToUi =
  | { readonly ev: 'ready'; readonly version: string }
  /** `report`: what was tried when it couldn't connect; `code`: the close code (4002, 4010). */
  | { readonly ev: 'phase'; readonly phase: LinkPhase; readonly detail?: string; readonly report?: DialReportJson; readonly code?: number }
  /** How the link (or pairing) got through, on which network: kept to try that way first next time. */
  | { readonly ev: 'path'; readonly path: LinkPathName; readonly way: Way; readonly tried: readonly Attempt[]; readonly relay?: string; readonly network?: string }
  | { readonly ev: 'ws.open'; readonly id: number; readonly url: string }
  | { readonly ev: 'ws.send'; readonly id: number; readonly b64: string }
  | { readonly ev: 'ws.close'; readonly id: number }
  /** One MacFrame, as JSON. */
  | { readonly ev: 'frame'; readonly json: string }
  | { readonly ev: 'pair.wait'; readonly id: number; readonly fingerprint: string; readonly secret: DeviceSecret }
  | { readonly ev: 'pair.ok'; readonly id: number; readonly pairing: Pairing; readonly secret: DeviceSecret }
  | { readonly ev: 'pair.fail'; readonly id: number; readonly reason: string; readonly report?: DialReportJson; readonly refusal?: string }
  | { readonly ev: 'log'; readonly line: string }
  /** `base`: http://127.0.0.1:<port>/<token>, the player's URLs go under it; `error` when it couldn't start. */
  | { readonly ev: 'media'; readonly id: number; readonly base?: string; readonly error?: string };

/** Newline-delimited JSON over a byte stream, both ways. */
export function lineDecoder(onLine: (line: string) => void): (chunk: Uint8Array | string) => void {
  let buffered = '';
  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : undefined;
  return (chunk) => {
    buffered += typeof chunk === 'string' ? chunk : decoder ? decoder.decode(chunk, { stream: true }) : String.fromCharCode(...chunk);
    let nl = buffered.indexOf('\n');
    while (nl >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (line) onLine(line);
      nl = buffered.indexOf('\n');
    }
  };
}

export const encodeLine = (msg: UiToWorklet | WorkletToUi): string => `${JSON.stringify(msg)}\n`;
