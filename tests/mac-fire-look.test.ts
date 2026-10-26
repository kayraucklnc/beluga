import { describe, expect, it } from 'vitest';
import { DEFAULT_FIRE, PRESETS, STARTERS, type FireLook, presetOf, starterOf } from '../packages/mac/src/chat/fire-look.js';

/** The welcome's Fire step: two pixel fires and None, each a whole choice. */
describe('the welcome’s fires', () => {
  const pick = (id: string, from: FireLook = DEFAULT_FIRE): FireLook => {
    const next = { ...from, ...STARTERS.find((x) => x.id === id)!.set };
    return { ...next, preset: presetOf(next) };
  };

  it('offers two pixel fires and None', () => {
    expect(STARTERS.map((x) => x.id)).toEqual(['arcade', 'ghost', 'none']);
    for (const id of ['arcade', 'ghost']) expect(pick(id).style).toBe('pixel');
  });

  it('recognises each once picked, and the two fires are presets Settings knows', () => {
    for (const x of STARTERS) expect(starterOf(pick(x.id))).toBe(x.id);
    expect(pick('arcade').preset).toBe('arcade');
    expect(pick('ghost').preset).toBe('ghost');
    expect(PRESETS.some((p) => p.id === 'ghost')).toBe(true);
  });

  it('None turns everything off but keeps the look for later', () => {
    const none = pick('none', pick('ghost'));
    expect([none.show, none.typing, none.popDelete]).toEqual(['off', 'off', false]);
    expect(none.palette).toBe('violet');
  });

  it('the default is none of them, so the step can start it on Arcade', () => {
    expect(starterOf(DEFAULT_FIRE)).toBeUndefined();
  });
});
