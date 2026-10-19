/**
 * JSON that keeps binary data (decoded images in the viewer): Uint8Arrays travel as base64.
 * Works in Node and in a browser.
 */

const B64 = '$u8';

function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(text, 'base64'));
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v instanceof Uint8Array ? { [B64]: toBase64(v) } : v));
}

export function decode(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === 'object' && B64 in v && typeof (v as Record<string, unknown>)[B64] === 'string' && Object.keys(v).length === 1) {
      return fromBase64((v as Record<string, string>)[B64]!);
    }
    return v;
  });
}
