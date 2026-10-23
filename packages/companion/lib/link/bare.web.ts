import type { DeviceSecret, Pairing } from './rpc';
import type { PairInput, PairStep, Transport } from './transport';

/** No Bare on the web: the web build is the demo only (and screenshots of it). */
export class BareTransport implements Transport {
  readonly kind = 'bare' as const;
  constructor(_creds: () => Promise<{ pairing: Pairing; secret: DeviceSecret } | undefined>) {}
  static available(): boolean {
    return false;
  }
  open(): void {}
  close(): void {}
  send(): void {}
  onFrame(): () => void {
    return () => {};
  }
  onPhase(listener: (phase: 'unreachable', detail?: string) => void): () => void {
    setTimeout(() => listener('unreachable', 'The real link runs on the phone only.'), 0);
    return () => {};
  }
  pair(_input: PairInput, onStep: (step: PairStep) => void): { cancel(): void } {
    onStep({ step: 'failed', reason: 'Pairing with a Mac works in the phone app. Try the demo here.' });
    return { cancel: () => {} };
  }
  dispose(): void {}
}
