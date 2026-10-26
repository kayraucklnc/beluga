/**
 * The phone's live video in the mirror (BLG-184). The phone's hardware encoder makes H.264 in
 * Annex B (units after 00 00 01 start codes, each key frame led by its SPS and PPS); WebCodecs
 * decodes it here and it's drawn on a canvas. WebKit's decoder takes AVCC (length-prefixed units,
 * the SPS/PPS in an avcC "description"), so each piece is rewritten on the way in.
 */

const SPS = 7;
const PPS = 8;
const AUD = 9;

const typeOf = (nal: Uint8Array): number => nal[0]! & 0x1f;

/** The units of an Annex B piece, start codes removed (a piece without one is a single unit). */
export function splitNals(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) out.push(trimZeros(bytes.subarray(start, i)));
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start < 0) return bytes.length ? [bytes] : [];
  out.push(bytes.subarray(start));
  return out.filter((n) => n.length > 0);
}

/** A unit never ends in a zero byte: those belong to the next 4-byte start code. */
function trimZeros(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end--;
  return nal.subarray(0, end);
}

/** The codec string for this SPS: avc1.PPCCLL (profile, constraints, level). */
export function codecOf(sps: Uint8Array): string {
  const hex = (b: number): string => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
}

/** The avcC record (AVCDecoderConfigurationRecord) for one SPS and PPS, 4-byte lengths. */
export function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profile = sps[1]!;
  // High profiles carry their chroma and bit depth: the phone's encoders make 4:2:0 at 8 bits.
  const high = [100, 110, 122, 144].includes(profile) ? [0xfd, 0xf8, 0xf8, 0x00] : [];
  const out = new Uint8Array(11 + sps.length + pps.length + high.length);
  out.set([1, profile, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 0xff], 0);
  out.set(sps, 8);
  const at = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], at);
  out.set(pps, at + 3);
  out.set(high, at + 3 + pps.length);
  return out;
}

/** Units → one AVCC sample (each with its 4-byte length), the parameter sets and delimiters left out. */
export function toAvcc(nals: readonly Uint8Array[]): Uint8Array {
  const keep = nals.filter((n) => ![SPS, PPS, AUD].includes(typeOf(n)));
  const out = new Uint8Array(keep.reduce((sum, n) => sum + 4 + n.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const n of keep) {
    view.setUint32(at, n.length);
    out.set(n, at + 4);
    at += 4 + n.length;
  }
  return out;
}

let canPlay: Promise<boolean> | undefined;

export interface VideoPiece {
  readonly b64: string;
  readonly key: boolean;
  readonly ts: number;
}

/**
 * Plays the pieces on a canvas. It starts at a key frame, and when it falls behind (or the decoder
 * fails) it waits for the next one rather than lagging or smearing; the phone sends one every few
 * seconds and whenever it skipped.
 */
export class H264Player {
  private decoder?: VideoDecoder;
  private configured?: string;
  private waitKey = true;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onDrawn: () => void,
  ) {
    this.ctx = canvas.getContext('2d');
  }

  /** This screen can decode H.264 with WebCodecs (some have WebCodecs but not H.264). Asked once. */
  static supported(): Promise<boolean> {
    canPlay ??= (async () => {
      if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false;
      try {
        return (await VideoDecoder.isConfigSupported({ codec: 'avc1.42e01f' })).supported === true;
      } catch {
        return false;
      }
    })();
    return canPlay;
  }

  push(piece: VideoPiece): void {
    const nals = splitNals(fromBase64(piece.b64));
    if (piece.key) {
      const sps = nals.find((n) => typeOf(n) === SPS);
      const pps = nals.find((n) => typeOf(n) === PPS);
      if (sps && pps) this.configure(sps, pps);
    }
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    if (this.waitKey && !piece.key) return;
    // Behind (decoding slower than it comes): skip to the next key frame.
    if (!piece.key && decoder.decodeQueueSize > 8) {
      this.waitKey = true;
      return;
    }
    this.waitKey = false;
    try {
      decoder.decode(new EncodedVideoChunk({ type: piece.key ? 'key' : 'delta', timestamp: piece.ts, data: toAvcc(nals) }));
    } catch {
      this.waitKey = true;
    }
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
  }

  private configure(sps: Uint8Array, pps: Uint8Array): void {
    const description = avcC(sps, pps);
    const id = description.join(',');
    if (id === this.configured && this.decoder?.state === 'configured') return;
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: (frame) => this.draw(frame),
        // A broken piece or a lost one: start again from the next key frame.
        error: () => {
          this.configured = undefined;
          this.waitKey = true;
        },
      });
    }
    this.decoder.configure({ codec: codecOf(sps), description, optimizeForLatency: true });
    this.configured = id;
    this.waitKey = true;
  }

  private draw(frame: VideoFrame): void {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx?.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.onDrawn();
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
