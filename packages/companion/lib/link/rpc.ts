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
}

/** The phone's own secret: the device key's seed (hex, 32 bytes). Lives in the secure store only. */
export interface DeviceSecret {
  readonly seed: string;
}

export type UiToWorklet =
  /** Dial the Mac and open the Noise stream. `hello` is sent by the worklet as the first frame. */
  | { readonly op: 'open'; readonly pairing: Pairing; readonly secret: DeviceSecret; readonly hello: string }
  /** One PhoneFrame, already JSON. */
  | { readonly op: 'frame'; readonly json: string }
  /** Close the stream and destroy the DHT node (no UDP, no keepalives). */
  | { readonly op: 'close'; readonly reason: string }
  /** Pair with a Mac: the QR's link or the typed code. A secret is made by the worklet if none is given. */
  | { readonly op: 'pair'; readonly id: number; readonly link?: string; readonly code?: string; readonly name: string; readonly platform: 'android' | 'ios'; readonly secret?: DeviceSecret }
  | { readonly op: 'pair.cancel'; readonly id: number };

export type LinkPhase = 'dialing' | 'open' | 'closed' | 'unreachable' | 'refused';

export type WorkletToUi =
  | { readonly ev: 'ready'; readonly version: string }
  | { readonly ev: 'phase'; readonly phase: LinkPhase; readonly detail?: string }
  /** One MacFrame, as JSON. */
  | { readonly ev: 'frame'; readonly json: string }
  | { readonly ev: 'pair.wait'; readonly id: number; readonly fingerprint: string; readonly secret: DeviceSecret }
  | { readonly ev: 'pair.ok'; readonly id: number; readonly pairing: Pairing; readonly secret: DeviceSecret }
  | { readonly ev: 'pair.fail'; readonly id: number; readonly reason: string }
  | { readonly ev: 'log'; readonly line: string };

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
