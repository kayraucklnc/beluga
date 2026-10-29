import { deflateSync } from 'node:zlib';

/**
 * A small made-up screenshot (a checkout page) the demo's friend sends to the room, drawn
 * here so the demo needs no image files. Written as a plain RGB PNG.
 */

type Rgb = readonly [number, number, number];
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: Rgb;
  readonly r?: number;
}

const W = 720;
const H = 450;

const SCENE: readonly Rect[] = [
  { x: 0, y: 0, w: W, h: H, color: [244, 244, 246] },
  { x: 0, y: 0, w: W, h: 44, color: [32, 33, 38] },
  { x: 18, y: 16, w: 12, h: 12, color: [237, 106, 94], r: 6 },
  { x: 36, y: 16, w: 12, h: 12, color: [245, 191, 79], r: 6 },
  { x: 54, y: 16, w: 12, h: 12, color: [98, 197, 84], r: 6 },
  { x: 250, y: 15, w: 220, h: 14, color: [62, 64, 72], r: 7 },
  // The card.
  { x: 160, y: 82, w: 400, h: 318, color: [255, 255, 255], r: 14 },
  { x: 196, y: 116, w: 150, h: 16, color: [40, 40, 46], r: 4 },
  { x: 196, y: 146, w: 240, h: 10, color: [196, 196, 204], r: 5 },
  { x: 196, y: 186, w: 328, h: 40, color: [238, 238, 242], r: 8 },
  { x: 196, y: 238, w: 156, h: 40, color: [238, 238, 242], r: 8 },
  { x: 368, y: 238, w: 156, h: 40, color: [238, 238, 242], r: 8 },
  // The bug: an error under the button.
  { x: 196, y: 300, w: 328, h: 44, color: [207, 106, 72], r: 10 },
  { x: 300, y: 317, w: 120, h: 10, color: [255, 236, 226], r: 5 },
  { x: 196, y: 360, w: 200, h: 10, color: [214, 58, 50], r: 5 },
];

/** The last shape drawn on a pixel wins. */
const TOP_FIRST = [...SCENE].reverse();

const inside = (rect: Rect, x: number, y: number): boolean => {
  if (x < rect.x || y < rect.y || x >= rect.x + rect.w || y >= rect.y + rect.h) return false;
  const r = rect.r ?? 0;
  if (!r) return true;
  const cx = Math.min(Math.max(x, rect.x + r), rect.x + rect.w - r);
  const cy = Math.min(Math.max(y, rect.y + r), rect.y + rect.h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A plain RGB PNG of `w`×`h`, each pixel from `at`. */
function png(w: number, h: number, at: (x: number, y: number) => Rgb): Buffer {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) rows.set(at(x, y), row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function demoScreenshot(): Buffer {
  return png(W, H, (x, y) => TOP_FIRST.find((rect) => inside(rect, x, y))?.color ?? [0, 0, 0]);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

/** A made-up profile picture (a pastel portrait: head and shoulders on a soft sky) for a demo friend. */
export function demoPortrait(size = 256): Buffer {
  const c = size / 2;
  return png(size, size, (x, y) => {
    const head = (x - c) ** 2 + (y - size * 0.4) ** 2 <= (size * 0.19) ** 2;
    const shoulders = (x - c) ** 2 / (size * 0.36) ** 2 + (y - size * 0.98) ** 2 / (size * 0.34) ** 2 <= 1;
    if (head) return [248, 214, 190];
    if (shoulders) return mix([186, 170, 232], [150, 134, 214], y / size);
    return mix([206, 228, 248], [244, 218, 232], (x + y) / (2 * size));
  });
}
