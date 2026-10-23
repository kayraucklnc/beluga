import { describe, expect, it } from 'vitest';
import { ago, leftText, markOf, seenText } from '../packages/mac/src/phone/phone-model.js';

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
