import { describe, expect, it } from 'vitest';
import { ago, leftText, markOf, seenText } from '../packages/mac/src/phone/phone-model.js';
import { avcC, codecOf, splitNals, toAvcc } from '../packages/mac/src/phone/h264.js';

const NOW = 1_760_000_000_000;
const pixel = { id: 'a'.repeat(16), name: 'Pixel 9', platform: 'android' as const, pairedAt: NOW - 86_400_000, push: false };

describe('the phone mark', () => {
  it('is lit while a phone is linked, and says when it was last seen otherwise', () => {
    expect(markOf([{ ...pixel, linked: true }], NOW)).toEqual({ lit: true, title: 'Pixel 9 · linked' });
    expect(markOf([{ ...pixel, linked: false, lastSeen: NOW - 12 * 60_000 }], NOW)).toEqual({ lit: false, title: 'Pixel 9 · last seen 12 min ago' });
    expect(seenText({ linked: false }, NOW)).toBe('not linked yet');
  });

  it('reads times the way people say them', () => {
    expect(ago(NOW - 20_000, NOW)).toBe('just now');
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(ago(NOW - 30 * 3_600_000, NOW)).toBe('yesterday');
    expect(leftText(NOW + 8 * 60_000, NOW)).toBe('8 min left');
    expect(leftText(NOW + 20_000, NOW)).toBe('less than a minute left');
  });
});

describe('the mirror’s live video (BLG-184)', () => {
  const sps = Uint8Array.from([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02]);
  const pps = Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
  const idr = Uint8Array.from([0x65, 0x88, 0x84, 0x21]);
  // A key frame as the phone's encoder makes it: SPS, PPS (4-byte start codes), then the picture (3-byte).
  const keyFrame = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...idr]);

  it('splits Annex B into its units, whichever start codes', () => {
    expect(splitNals(keyFrame).map((n) => [...n])).toEqual([[...sps], [...pps], [...idr]]);
    expect(splitNals(Uint8Array.from([0x41, 0x9a]))).toHaveLength(1);
  });

  it('describes the stream the way WebCodecs wants it', () => {
    expect(codecOf(sps)).toBe('avc1.42c01f');
    const record = avcC(sps, pps);
    expect([...record.subarray(0, 8)]).toEqual([1, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0, sps.length]);
    expect([...record.subarray(8 + sps.length, 11 + sps.length)]).toEqual([1, 0, pps.length]);
    // A High-profile stream also says its chroma and bit depth.
    expect(avcC(Uint8Array.from([0x67, 100, 0, 0x28]), pps).length).toBe(11 + 4 + pps.length + 4);
  });

  it('rewrites a piece as one length-prefixed sample, without its parameter sets', () => {
    const sample = toAvcc(splitNals(keyFrame));
    expect([...sample]).toEqual([0, 0, 0, idr.length, ...idr]);
  });
});
