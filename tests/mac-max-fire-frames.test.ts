import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaxFire } from '../packages/mac/src/chat/max-fire.js';

/** A 120 Hz screen: one second of animation frames, by hand. */
let frames: ((now: number) => void)[] = [];
let focused = true;
const second = (): void => {
  for (let i = 1, start = performance.now(); i <= 120; i++) {
    const run = frames;
    frames = [];
    for (const f of run) f(start + i * (1000 / 120));
  }
};

const canvas = (): HTMLCanvasElement => {
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'canvas' ? undefined : () => undefined) });
  return { width: 0, height: 0, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx : null) } as unknown as HTMLCanvasElement;
};

const fire = (show: 'always' | 'typing'): { f: MaxFire; draws: () => number } => {
  const f = new MaxFire(canvas(), canvas());
  f.setTune({ style: 'toon', show, fuel: 0.5, height: 0.5, thickness: 0.5, wildness: 0.5, colors: ['#a0c4ff', '#bdb2ff', '#ffc6ff'], temper: false, catchAfter: 0, outAfter: 0.4 });
  f.resize(400, 200, { x: 40, y: 80, w: 320, h: 80 });
  let n = 0;
  const target = f as unknown as { draw: () => void };
  const draw = target.draw.bind(f);
  target.draw = () => {
    n++;
    draw();
  };
  f.start();
  return { f, draws: () => n };
};

beforeEach(() => {
  frames = [];
  focused = true;
  vi.stubGlobal('window', { devicePixelRatio: 2 });
  vi.stubGlobal('document', { hasFocus: () => focused });
  vi.stubGlobal('requestAnimationFrame', (f: (now: number) => void) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => (frames = []));
});
afterEach(() => vi.unstubAllGlobals());

describe('Max Fire spends frames only where they show (BLG-365)', () => {
  it('draws a fire left burning at about 30 a second, not every frame', () => {
    const { draws } = fire('always');
    second();
    expect(draws()).toBeGreaterThan(25);
    expect(draws()).toBeLessThanOrEqual(31);
  });

  it('draws every frame while you type', () => {
    const { f, draws } = fire('always');
    f.stoke({ x: 100, y: 100 });
    f.burst({ x: 100, y: 100 });
    second();
    expect(draws()).toBeGreaterThan(100);
  });

  it('slows to 10 a second behind another app', () => {
    focused = false;
    const { draws } = fire('always');
    second();
    expect(draws()).toBeLessThanOrEqual(11);
  });

  it('draws nothing more once it is out (only while typing, nothing typed)', () => {
    const { draws } = fire('typing');
    second();
    const once = draws();
    second();
    expect(once).toBeLessThanOrEqual(1);
    expect(draws()).toBe(once);
  });
});
