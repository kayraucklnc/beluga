import { describe, expect, it } from 'vitest';
import { DONE_KEY, PREFS_KEY, STEPS, TOUR, afterTour, inTour, saveMark, shouldShow, stepBy , tourPlace } from '../packages/mac/src/onboarding/onboarding-model.js';

/** The Mac app's first-run welcome (packages/mac/src/onboarding): when it shows, and how it steps. */

const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('when the welcome shows', () => {
  it('shows on a fresh install', () => {
    expect(shouldShow(memory())).toBe(true);
  });

  it('never shows to someone who used Beluga before it existed', () => {
    expect(shouldShow(memory({ [PREFS_KEY]: '{}' }))).toBe(false);
  });

  it('stays away once finished or skipped, whatever version is installed next', () => {
    const store = memory();
    saveMark(store, '0.6.3', 'finished');
    expect(shouldShow(store)).toBe(false);
    saveMark(store, '0.6.3', 'skipped');
    expect(shouldShow(store)).toBe(false);
  });

  it('comes back after quitting halfway, even though picking a theme wrote preferences', () => {
    const store = memory({ [PREFS_KEY]: '{"appearance":"dark"}' });
    saveMark(store, '0.6.3', 'started');
    expect(shouldShow(store)).toBe(true);
  });

  it('shows when asked with ?welcome', () => {
    const store = memory();
    saveMark(store, '1.0.0', 'finished');
    expect(shouldShow(store, '?welcome')).toBe(true);
  });

  it('treats an unreadable mark as done, and storage that throws as nothing to show', () => {
    expect(shouldShow(memory({ [DONE_KEY]: 'not json' }))).toBe(false);
    expect(shouldShow({ getItem: () => { throw new Error('off'); }, setItem: () => undefined })).toBe(false);
  });

  it('keeps what it saved: the version, when, and how', () => {
    const store = memory();
    expect(saveMark(store, '0.7.0', 'finished', 42)).toEqual({ version: '0.7.0', at: 42, how: 'finished' });
    expect(JSON.parse(store.data.get(DONE_KEY)!)).toEqual({ version: '0.7.0', at: 42, how: 'finished' });
    expect(() => saveMark({ getItem: () => null, setItem: () => { throw new Error('full'); } }, '1', 'finished')).not.toThrow();
  });
});

describe('stepping through it', () => {
  it('goes from the welcome through the tour to the settings and the end', () => {
    expect(STEPS[0]).toBe('hello');
    expect(STEPS.at(-1)).toBe('ready');
    expect(stepBy('hello', 1)).toBe('parallel');
    expect(stepBy('hello', -1)).toBe('hello');
    expect(stepBy('ready', 1)).toBe('ready');
  });

  it('places the tour steps ("2 of 5") and skips past them to the look', () => {
    expect(TOUR.every(inTour)).toBe(true);
    expect(inTour('setup')).toBe(false);
    expect(tourPlace('agents')).toEqual({ at: 2, of: TOUR.length });
    expect(tourPlace('look')).toBeUndefined();
    expect(afterTour()).toBe('look');
    expect(STEPS.indexOf(afterTour())).toBe(STEPS.indexOf(TOUR.at(-1)!) + 1);
  });
});
