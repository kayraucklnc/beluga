import { Worklet } from 'react-native-bare-kit';
import bundle from '../../worklet/dist/link.bundle.mjs';
import { type MacFrame, type PhoneFrame, parseMacFrame } from './protocol';
import { type DeviceSecret, encodeLine, type LinkPhase, lineDecoder, type Pairing, type UiToWorklet, type WorkletToUi } from './rpc';
import { Emitter, type PairInput, type PairStep, type Transport } from './transport';

/**
 * The real link: a Bare worklet (react-native-bare-kit) running worklet/link.ts, which dials your
 * Mac over hyperdht and holds one Noise stream (src/companion/client.ts). The worklet starts when
 * the app needs the link and is terminated when the link closes: no DHT node, no UDP, no wakeups
 * while you're not looking (docs/companion.md, Battery).
 *
 * The bundle is made by `npm run worklet:bundle` (bare-pack). Without it (a fresh checkout), Metro
 * resolves the import to an empty module and this transport reports itself unavailable.
 */
export class BareTransport implements Transport {
  readonly kind = 'bare' as const;
  private worklet: Worklet | undefined;
  private readonly frames = new Emitter<[MacFrame]>();
  private readonly phases = new Emitter<[LinkPhase, string?]>();
  private readonly pairs = new Map<number, (step: PairStep) => void>();
  private pairSeq = 0;

  constructor(
    private readonly creds: () => Promise<{ pairing: Pairing; secret: DeviceSecret } | undefined>,
  ) {}

  static available(): boolean {
    const b: unknown = bundle;
    return typeof b === 'string' || b instanceof Uint8Array;
  }

  private start(): Worklet {
    if (this.worklet) return this.worklet;
    if (!BareTransport.available()) throw new Error('The link worklet is not bundled (npm run worklet:bundle).');
    const w = new Worklet();
    if (typeof bundle === 'string') w.start('/link.bundle', bundle);
    else w.start('/link.bundle', bundle as Uint8Array);
    const decode = lineDecoder((line) => this.onLine(line));
    w.IPC.on('data', (chunk) => decode(chunk as Uint8Array));
    this.worklet = w;
    return w;
  }

  private post(msg: UiToWorklet): void {
    this.start().IPC.write(encodeLine(msg));
  }

  private onLine(line: string): void {
    let msg: WorkletToUi;
    try {
      msg = JSON.parse(line) as WorkletToUi;
    } catch {
      return;
    }
    switch (msg.ev) {
      case 'phase':
        this.phases.emit(msg.phase, msg.detail);
        if (msg.phase === 'closed' || msg.phase === 'unreachable' || msg.phase === 'refused') this.stopWorklet();
        return;
      case 'frame': {
        const frame = parseMacFrame(msg.json);
        if (frame) this.frames.emit(frame);
        return;
      }
      case 'pair.wait':
        this.pairs.get(msg.id)?.({ step: 'waiting', fingerprint: msg.fingerprint });
        return;
      case 'pair.ok':
        this.pairs.get(msg.id)?.({ step: 'paired', pairing: msg.pairing, secret: msg.secret });
        this.pairs.delete(msg.id);
        return;
      case 'pair.fail':
        this.pairs.get(msg.id)?.({ step: 'failed', reason: msg.reason });
        this.pairs.delete(msg.id);
        return;
      case 'log':
        if (__DEV__) console.log('[link]', msg.line);
        return;
      default:
        return;
    }
  }

  open(hello: PhoneFrame & { t: 'hello' }): void {
    this.phases.emit('dialing');
    void this.creds().then((c) => {
      if (!c) return this.phases.emit('refused', 'This phone is not paired.');
      try {
        this.post({ op: 'open', pairing: c.pairing, secret: c.secret, hello: JSON.stringify(hello) });
      } catch (e) {
        this.phases.emit('unreachable', (e as Error).message);
      }
    });
  }

  close(reason: string): void {
    if (!this.worklet) return;
    this.post({ op: 'close', reason });
  }

  send(frame: PhoneFrame): void {
    if (this.worklet) this.post({ op: 'frame', json: JSON.stringify(frame) });
  }

  onFrame(listener: (frame: MacFrame) => void): () => void {
    return this.frames.on(listener);
  }
  onPhase(listener: (phase: LinkPhase, detail?: string) => void): () => void {
    return this.phases.on(listener);
  }

  pair(input: PairInput, onStep: (step: PairStep) => void): { cancel(): void } {
    const id = ++this.pairSeq;
    this.pairs.set(id, onStep);
    onStep({ step: 'dialing' });
    try {
      this.post({ op: 'pair', id, ...input });
    } catch (e) {
      onStep({ step: 'failed', reason: (e as Error).message });
    }
    return {
      cancel: () => {
        this.pairs.delete(id);
        if (this.worklet) this.post({ op: 'pair.cancel', id });
      },
    };
  }

  /** The worklet goes entirely when the link is down: the battery rule. */
  private stopWorklet(): void {
    if (this.pairs.size > 0) return;
    this.worklet?.terminate();
    this.worklet = undefined;
  }

  dispose(): void {
    this.worklet?.terminate();
    this.worklet = undefined;
    this.frames.clear();
    this.phases.clear();
    this.pairs.clear();
  }
}
