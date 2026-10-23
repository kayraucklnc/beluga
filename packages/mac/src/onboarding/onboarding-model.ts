/**
 * The first time Beluga opens: a welcome, a short tour, a few settings, then the app. It shows
 * once per Mac. Updating the app never brings it back (the mark is kept with this window's own
 * storage, which an update leaves alone), and someone who used Beluga before it existed never
 * sees it either. File › Onboard Again (or Help › Welcome to Beluga, or the palette) shows it again.
 */

/** Where the mark that you've been through it is kept. */
export const DONE_KEY = 'beluga.onboarding.v1';
/** Beluga's own window preferences (lib/prefs.ts): there only once someone has used the app. */
export const PREFS_KEY = 'beluga.prefs.v1';
/** `?welcome` in the address shows it whatever the mark says (screenshots, development). */
export const FORCE_PARAM = 'welcome';
/** The document event File › Onboard Again, Help › Welcome to Beluga and the palette send to show it again. */
export const SHOW_WELCOME = 'beluga:welcome';

export const STEPS = ['hello', 'parallel', 'agents', 'friends', 'earnings', 'archive', 'look', 'setup', 'popups', 'ready'] as const;

/** The last step before the app (its button says Finish). */
export const LAST_SETTING: Step = 'popups';
export type Step = (typeof STEPS)[number];

/** The tour: what Beluga does, one idea a step (Skip Tour goes past all of them). */
export const TOUR: readonly Step[] = ['parallel', 'agents', 'friends', 'earnings', 'archive'];

export interface DoneMark {
  /** The app's version when you finished (or skipped). */
  readonly version: string;
  readonly at: number;
  /** Finished every step, left early, or still in it (quit halfway: it shows again). */
  readonly how: 'finished' | 'skipped' | 'started';
}

/** What `shouldShow` reads: a localStorage, or a stand-in for one in a test. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readMark(raw: string | null): DoneMark | undefined {
  if (raw === null) return undefined;
  try {
    const mark = JSON.parse(raw) as Partial<DoneMark>;
    return mark.how === 'finished' || mark.how === 'skipped' || mark.how === 'started' ? (mark as DoneMark) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether to show it now: asked for, or never finished it. Someone with preferences but no mark
 * used Beluga before the onboarding existed, and isn't shown it. (Picking a theme in it writes
 * preferences too, so it marks itself `started` first: quit halfway and it's back next time.)
 */
export function shouldShow(store: Store, search = ''): boolean {
  if (new URLSearchParams(search).has(FORCE_PARAM)) return true;
  try {
    const raw = store.getItem(DONE_KEY);
    const mark = readMark(raw);
    if (mark) return mark.how === 'started';
    // A mark that can't be read: treat it as done rather than showing it on every launch.
    if (raw !== null) return false;
    return store.getItem(PREFS_KEY) === null;
  } catch {
    // No storage to read: showing it every launch would be worse than not at all.
    return false;
  }
}

export function saveMark(store: Store, version: string, how: DoneMark['how'], now = Date.now()): DoneMark {
  const mark: DoneMark = { version, at: now, how };
  try {
    store.setItem(DONE_KEY, JSON.stringify(mark));
  } catch {
    // Storage full or off: it shows again next time, which is the lesser problem.
  }
  return mark;
}

export const stepIndex = (step: Step): number => STEPS.indexOf(step);

/** The step `by` places along (clamped to the first and last). */
export function stepBy(step: Step, by: number): Step {
  const i = Math.min(STEPS.length - 1, Math.max(0, stepIndex(step) + by));
  return STEPS[i]!;
}

/** From inside the tour (or the welcome), Skip Tour goes straight to the settings. */
export const afterTour = (): Step => 'look';

export const inTour = (step: Step): boolean => TOUR.includes(step);

/** "2 of 5" for the tour's steps; nothing for the others. */
export function tourPlace(step: Step): { readonly at: number; readonly of: number } | undefined {
  const i = TOUR.indexOf(step);
  return i < 0 ? undefined : { at: i + 1, of: TOUR.length };
}
