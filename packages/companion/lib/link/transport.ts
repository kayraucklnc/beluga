import type { MacFrame, PhoneFrame } from './protocol';
import type { Diagnosis } from './diagnose';
import type { Attempt, DeviceSecret, DialReportJson, LinkHints, LinkPathName, LinkPhase, Pairing, Way } from './rpc';

/** Why it couldn't connect (or closed), for the explanation (src/companion/diagnose.ts). */
export interface PhaseInfo {
  readonly report?: DialReportJson;
  readonly code?: number;
}

/** How a link or a pairing got through. */
export interface PathInfo {
  readonly path: LinkPathName;
  readonly way: Way;
  readonly tried: readonly Attempt[];
  readonly relay?: string;
  readonly network?: string;
}

/**
 * How the screens reach a Mac. Two implementations: `BareTransport` (the real link, in a Bare
 * worklet) and `DemoTransport` (a convincing Mac inside the app, for trying it without one).
 * The screens never see which: they talk to the store (lib/store.ts), the store to a Transport.
 */
export interface Transport {
  readonly kind: 'bare' | 'demo';
  /** Dial and open the link; the first frame sent is `hello`. Idempotent while open. */
  open(hello: PhoneFrame & { t: 'hello' }, hints?: LinkHints): void;
  /** Close it now (the app went to the background past the grace, or you signed out). */
  close(reason: string): void;
  send(frame: PhoneFrame): void;
  /**
   * Is the open link still alive (a ping, answered within `ms`)? A link that isn't is dropped, and
   * its `closed` phase follows. Without it (the demo), the link is taken as alive.
   */
  probe?(ms: number): Promise<boolean>;
  onFrame(listener: (frame: MacFrame) => void): () => void;
  onPhase(listener: (phase: LinkPhase, detail?: string, info?: PhaseInfo) => void): () => void;
  /** How the link got through (the real link only). */
  onPath?(listener: (info: PathInfo) => void): () => void;
  /** Pair with a Mac (from a QR link or a typed code). */
  pair(input: PairInput, onStep: (step: PairStep) => void): { cancel(): void };
  dispose(): void;
}

export interface PairInput {
  readonly link?: string;
  readonly code?: string;
  /** This phone's name as the Mac shows it ("Mia's Pixel 9"). */
  readonly name: string;
  readonly platform: 'android' | 'ios';
  readonly hints?: LinkHints;
}

export type PairStep =
  | { readonly step: 'dialing' }
  /** The Mac is asking "Pair this phone?"; the same fingerprint shows there. */
  | { readonly step: 'waiting'; readonly fingerprint: string }
  | { readonly step: 'paired'; readonly pairing: Pairing; readonly secret: DeviceSecret }
  | { readonly step: 'failed'; readonly reason: string; readonly report?: DialReportJson; readonly refusal?: string; /** What went wrong in words (the store adds it). */ readonly diagnosis?: Diagnosis };

/** A tiny typed emitter for the implementations. */
export class Emitter<T extends unknown[]> {
  private readonly listeners = new Set<(...args: T) => void>();
  on(fn: (...args: T) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  emit(...args: T): void {
    for (const fn of [...this.listeners]) fn(...args);
  }
  clear(): void {
    this.listeners.clear();
  }
}
