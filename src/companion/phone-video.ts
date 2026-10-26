import type { Adb } from './phone-adb.js';

/**
 * The phone's screen as live video over adb (BLG-185): Android's own `screenrecord` writes H.264
 * to stdout, adb carries it, and it's cut into pictures here for the mirror's player, the same
 * pieces the app's own stream sends (BLG-184). adb's shell may capture the screen, so nothing asks
 * on the phone. screenrecord stops after 3 minutes; it's started again then.
 */

/** A piece of the phone's screen video: H.264 Annex B, `w`×`h` of a `sw`×`sh` screen (taps map to those). */
export interface VideoPiece {
  readonly seq: number;
  readonly b64: string;
  readonly key: boolean;
  readonly ts: number;
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
}

const SPS = 7;
const PPS = 8;
const AUD = 9;
const IDR = 5;
const SLICE = 1;

/** Where each unit starts (its start code, the 4-byte kind included) in an Annex B buffer. */
function unitStarts(buf: Buffer): number[] {
  const at: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1) {
      at.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
      i += 2;
    }
  }
  return at;
}

const headerAt = (unit: Buffer): number => (unit[2] === 1 ? 3 : 4);
const startsWithCode = (b: Buffer): boolean => (b.length > 2 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1)));

/**
 * An H.264 byte stream (Annex B, arriving in any chunks) cut into pictures: one access unit a
 * piece, and a key frame with the latest SPS and PPS in front so a decoder can start there. A unit
 * is whole when the next one starts, or when nothing more comes for `idleMs` (screenrecord writes a
 * picture at a time, so the last one isn't held back until the screen changes again).
 */
export class AnnexBSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private unitsOf: Buffer[] = [];
  private hasPicture = false;
  private key = false;
  private sps?: Buffer;
  private pps?: Buffer;
  /** The last unit was taken as whole on a pause: what comes next must start a new one. */
  private cut = false;
  /** A piece went out cut short: nothing more until the next key frame. */
  private broken = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onPiece: (bytes: Buffer, key: boolean) => void,
    private readonly idleMs = 40,
  ) {}

  push(chunk: Buffer): void {
    clearTimeout(this.timer);
    if (this.cut && !startsWithCode(chunk)) this.broken = true;
    this.cut = false;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const starts = unitStarts(this.buf);
    if (!starts.length) {
      // No unit has started yet (or only a broken tail): keep a little, never everything.
      if (this.buf.length > 4) this.buf = Buffer.from(this.buf.subarray(this.buf.length - 4));
      return;
    }
    for (let i = 0; i + 1 < starts.length; i++) this.unit(this.buf.subarray(starts[i], starts[i + 1]));
    this.buf = Buffer.from(this.buf.subarray(starts.at(-1)));
    this.timer = setTimeout(() => this.idle(), this.idleMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  close(): void {
    clearTimeout(this.timer);
  }

  private idle(): void {
    if (this.buf.length > 4) {
      this.unit(this.buf);
      this.buf = Buffer.alloc(0);
      this.cut = true;
    }
    this.flush();
  }

  private unit(unit: Buffer): void {
    const at = headerAt(unit);
    if (unit.length <= at) return;
    const type = unit[at]! & 0x1f;
    const picture = type === SLICE || type === IDR;
    // A new picture starts with anything but a slice, or with a slice whose first_mb_in_slice is 0.
    const starts = !picture || (unit.length > at + 1 && (unit[at + 1]! & 0x80) !== 0);
    if (this.hasPicture && starts) this.flush();
    if (type === SPS) return void (this.sps = Buffer.from(unit));
    if (type === PPS) return void (this.pps = Buffer.from(unit));
    if (type === AUD) return;
    this.unitsOf.push(unit);
    if (picture) {
      this.hasPicture = true;
      if (type === IDR) this.key = true;
    }
  }

  private flush(): void {
    if (!this.hasPicture) return;
    const key = this.key;
    const units = key && this.sps && this.pps ? [this.sps, this.pps, ...this.unitsOf] : this.unitsOf;
    this.unitsOf = [];
    this.hasPicture = false;
    this.key = false;
    if (key) this.broken = false;
    if (!this.broken) this.onPiece(Buffer.concat(units), key);
  }
}

/** The video's size for a screen: the longest side `max` at most, both sides a multiple of 16 (encoders like that). */
export function videoSize(screen: { w: number; h: number }, max: number): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(screen.w, screen.h));
  const fit = (v: number): number => Math.max(16, Math.round((v * scale) / 16) * 16);
  return { w: fit(screen.w), h: fit(screen.h) };
}

/**
 * Stream the phone's screen over adb until stop(). Resolves undefined when it can't (no streaming
 * here, or the screen's size unknown). `onEnd` says why when it stops for good: screenrecord
 * failing before its first picture (a phone without it, a size its encoder refuses).
 */
export async function adbScreenVideo(adb: Adb, opts: { max: number; kbps: number }, onPiece: (p: VideoPiece) => void, onEnd: (error: string) => void): Promise<{ stop(): void } | undefined> {
  const screen = await adb.screenSize();
  if (!screen) return undefined;
  const size = videoSize(screen, opts.max);
  const t0 = Date.now();
  let seq = 0;
  let stopped = false;
  let current: { stop(): void } | undefined;
  const run = (): boolean => {
    let pictures = 0;
    const splitter = new AnnexBSplitter((bytes, key) => {
      if (stopped) return;
      pictures++;
      onPiece({ seq: seq++, b64: bytes.toString('base64'), key, ts: (Date.now() - t0) * 1000, w: size.w, h: size.h, sw: screen.w, sh: screen.h });
    });
    const args = ['screenrecord', '--output-format=h264', '--size', `${size.w}x${size.h}`, '--bit-rate', String(opts.kbps * 1000), '--time-limit', '180', '-'];
    current = adb.stream(args, (chunk) => splitter.push(chunk), (code, stderr) => {
      splitter.close();
      if (stopped) return;
      // It ran (its 3 minutes are up, or the screen turned): again. It never showed a picture: give up.
      if (pictures > 0) run();
      else onEnd(stderr || `screenrecord stopped (${code ?? 'killed'})`);
    });
    return Boolean(current);
  };
  if (!run()) return undefined;
  return {
    stop: () => {
      stopped = true;
      current?.stop();
    },
  };
}
