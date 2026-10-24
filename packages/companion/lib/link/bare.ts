import { Worklet } from 'react-native-bare-kit';
import bundle from '../../worklet/dist/link.bundle.mjs';
import { type MacFrame, type PhoneFrame, parseMacFrame } from './protocol';
import { fromB64, toB64 } from '../b64';
import { type DeviceSecret, encodeLine, type LinkHints, type LinkPhase, lineDecoder, type Pairing, type UiToWorklet, type WorkletToUi } from './rpc';
import { Emitter, type PairInput, type PairStep, type PathInfo, type PhaseInfo, type Transport } from './transport';

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
  private readonly phases = new Emitter<[LinkPhase, string?, PhaseInfo?]>();
  private readonly paths = new Emitter<[PathInfo]>();
  /** The relay's WebSockets the worklet asked for (React Native's; Bare has none). */
  private readonly sockets = new Map<number, WebSocket>();
  private readonly pairs = new Map<number, (step: PairStep) => void>();
  private pairSeq = 0;
  /** Asks for the media server's base URL, by id (the worklet answers `media`). */
  private readonly medias = new Map<number, { resolve: (base: string) => void; reject: (e: Error) => void }>();
  private mediaSeq = 0;
  /** The base URL while this worklet runs (a new worklet has a new server). */
  private media: Promise<string> | undefined;

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
    // BareKit's IPC takes bytes, not strings.
    this.start().IPC.write(new TextEncoder().encode(encodeLine(msg)));
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
        this.phases.emit(msg.phase, msg.detail, { ...(msg.report ? { report: msg.report } : {}), ...(msg.code !== undefined ? { code: msg.code } : {}) });
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
        this.pairs.get(msg.id)?.({ step: 'failed', reason: msg.reason, ...(msg.report ? { report: msg.report } : {}), ...(msg.refusal ? { refusal: msg.refusal } : {}) });
        this.pairs.delete(msg.id);
        return;
      case 'path':
        this.paths.emit({ path: msg.path, way: msg.way, tried: msg.tried, ...(msg.relay ? { relay: msg.relay } : {}), ...(msg.network ? { network: msg.network } : {}) });
        return;
      case 'ws.open':
        return this.openSocket(msg.id, msg.url);
      case 'ws.send': {
        const ws = this.sockets.get(msg.id);
        if (ws?.readyState === WebSocket.OPEN) ws.send(fromB64(msg.b64).buffer as ArrayBuffer);
        return;
      }
      case 'ws.close': {
        const ws = this.sockets.get(msg.id);
        this.sockets.delete(msg.id);
        ws?.close();
        return;
      }
      case 'log':
        if (__DEV__) console.log('[link]', msg.line);
        return;
      case 'media': {
        const m = this.medias.get(msg.id);
        this.medias.delete(msg.id);
        if (msg.base) m?.resolve(msg.base);
        else m?.reject(new Error(msg.error ?? 'Videos can’t play right now'));
        return;
      }
      default:
        return;
    }
  }

  /**
   * A WebSocket to the relay for the worklet: Noise ciphertext both ways, base64 over the IPC. The
   * relay's TLS is the OS's, and the keys inside are pinned by Noise either way.
   */
  private openSocket(id: number, url: string): void {
    const event = (e: Omit<Extract<UiToWorklet, { op: 'ws.event' }>, 'op' | 'id'>): void => {
      if (this.worklet) this.post({ op: 'ws.event', id, ...e });
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return event({ kind: 'close' });
    }
    ws.binaryType = 'arraybuffer';
    this.sockets.set(id, ws);
    ws.onopen = () => event({ kind: 'open' });
    ws.onmessage = (m) => {
      if (m.data instanceof ArrayBuffer) event({ kind: 'message', b64: toB64(new Uint8Array(m.data)) });
    };
    ws.onclose = (c) => {
      this.sockets.delete(id);
      event({ kind: 'close', code: c.code });
    };
    ws.onerror = () => undefined;
  }

  open(hello: PhoneFrame & { t: 'hello' }, hints?: LinkHints): void {
    this.phases.emit('dialing');
    void this.creds().then((c) => {
      if (!c) return this.phases.emit('refused', 'This phone is not paired.');
      try {
        this.post({ op: 'open', pairing: c.pairing, secret: c.secret, hello: JSON.stringify(hello), ...(hints ? { hints } : {}) });
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
  onPhase(listener: (phase: LinkPhase, detail?: string, info?: PhaseInfo) => void): () => void {
    return this.phases.on(listener);
  }
  onPath(listener: (info: PathInfo) => void): () => void {
    return this.paths.on(listener);
  }

  mediaBase(): Promise<string> {
    if (!this.worklet) return Promise.reject(new Error('Your Mac is away'));
    this.media ??= new Promise<string>((resolve, reject) => {
      const id = ++this.mediaSeq;
      this.medias.set(id, { resolve, reject });
      this.post({ op: 'media', id });
    }).catch((e: Error) => {
      this.media = undefined;
      throw e;
    });
    return this.media;
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
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    this.worklet?.terminate();
    this.worklet = undefined;
    this.dropMedia();
  }

  private dropMedia(): void {
    this.media = undefined;
    for (const m of this.medias.values()) m.reject(new Error('Your Mac is away'));
    this.medias.clear();
  }

  dispose(): void {
    this.dropMedia();
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    this.worklet?.terminate();
    this.worklet = undefined;
    this.frames.clear();
    this.phases.clear();
    this.pairs.clear();
  }
}
