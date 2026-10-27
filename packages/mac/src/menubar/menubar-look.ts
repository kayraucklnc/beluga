/**
 * Settings › Menu Bar (BLG-280): what the number beside the menu-bar whale counts, how it reads,
 * and when the whale spouts. Kept on this Mac (UiPrefs.menuBar).
 */

/** What the number counts. */
export type MenuBarCount = 'new' | 'waiting' | 'working' | 'room' | 'friends' | 'none';
/** When the whale spouts: once each time a Claude finishes, every few seconds while one works, or never. */
export type MenuBarSpout = 'done' | 'working' | 'off';

export interface MenuBarLook {
  readonly preset: string;
  readonly count: MenuBarCount;
  /** "3 new" instead of "3". */
  readonly words: boolean;
  readonly spout: MenuBarSpout;
  /** 0: a small puff, 1: a big splash. */
  readonly splash: number;
  /** 0: slow, 1: quick. */
  readonly speed: number;
}

/** Each count: its name, what it means (said in Settings), and its word in the menu bar. */
export const COUNTS: ReadonlyArray<{ readonly id: MenuBarCount; readonly label: string; readonly means: string; readonly word: string }> = [
  { id: 'new', label: 'What’s New for You', means: 'Conversations in Unread, unread notifications, and what waits on you (the Dock badge counts the same).', word: 'new' },
  { id: 'waiting', label: 'Waiting for You', means: 'Only what needs your answer: approvals, Claude’s questions and people at the door.', word: 'waiting' },
  { id: 'working', label: 'Claudes Working', means: 'Conversations where your Claude is at work right now.', word: 'working' },
  { id: 'room', label: 'People in the Room', means: 'Everyone in your room besides you.', word: 'here' },
  { id: 'friends', label: 'Friends Online', means: 'Friends on the Beluga network who are online now.', word: 'online' },
  { id: 'none', label: 'Nothing', means: 'Just the whale. Its menu still lists what waits on you.', word: '' },
];

export const DEFAULT_MENU_BAR: MenuBarLook = { preset: 'classic', count: 'new', words: false, spout: 'done', splash: 0.5, speed: 0.5 };

type LookPart = Omit<MenuBarLook, 'preset'>;

export const MENU_BAR_PRESETS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly blurb: string; readonly look: LookPart }> = [
  { id: 'classic', name: 'What’s New', blurb: 'The count, and a spout when Claude finishes', look: { count: 'new', words: false, spout: 'done', splash: 0.5, speed: 0.5 } },
  { id: 'quiet', name: 'Just the Whale', blurb: 'No number, no spout', look: { count: 'none', words: false, spout: 'off', splash: 0.5, speed: 0.5 } },
  { id: 'people', name: 'Who’s Here', blurb: 'People in your room, in words', look: { count: 'room', words: true, spout: 'done', splash: 0.35, speed: 0.5 } },
  { id: 'busy', name: 'Busy Whale', blurb: 'Claudes working, spouting while they do', look: { count: 'working', words: true, spout: 'working', splash: 0.75, speed: 0.65 } },
];

const same = (a: LookPart, b: LookPart): boolean => a.count === b.count && a.words === b.words && a.spout === b.spout && Math.abs(a.splash - b.splash) < 0.001 && Math.abs(a.speed - b.speed) < 0.001;

/** The preset these settings are ('custom': tuned by you). */
export function menuBarPresetOf(look: LookPart): string {
  return MENU_BAR_PRESETS.find((p) => same(p.look, look))?.id ?? 'custom';
}

const unit = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

/** Saved settings, made whole (and anything unknown put back to the default). */
export function menuBarLookOf(saved: unknown): MenuBarLook {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof MenuBarLook, unknown>>;
  const d = DEFAULT_MENU_BAR;
  const look: LookPart = {
    count: COUNTS.some((c) => c.id === s.count) ? (s.count as MenuBarCount) : d.count,
    words: typeof s.words === 'boolean' ? s.words : d.words,
    spout: s.spout === 'done' || s.spout === 'working' || s.spout === 'off' ? s.spout : d.spout,
    splash: unit(s.splash, d.splash),
    speed: unit(s.speed, d.speed),
  };
  return { ...look, preset: menuBarPresetOf(look) };
}

/** Everything the number can count, right now. */
export type MenuBarCounts = Readonly<Record<Exclude<MenuBarCount, 'none'>, number>>;

/** What the menu bar shows beside the whale: "3", "3 new", or "" (nothing, at zero too). */
export function trayTitle(look: Pick<MenuBarLook, 'count' | 'words'>, counts: MenuBarCounts): string {
  if (look.count === 'none') return '';
  const n = counts[look.count];
  if (n <= 0) return '';
  const word = COUNTS.find((c) => c.id === look.count)?.word;
  return look.words && word ? `${n} ${word}` : String(n);
}

/** How often the whale spouts while Claude works. */
export const SPOUT_EVERY_MS = 6000;

/**
 * What the spout does as the working count moves from `before` to `now`: 'once' when a Claude
 * finished, 'repeat' / 'stop' to start or stop spouting while one works, nothing otherwise.
 */
export function spoutStep(spout: MenuBarSpout, before: number | undefined, now: number): 'once' | 'repeat' | 'stop' | undefined {
  if (spout === 'working') return now > 0 ? 'repeat' : 'stop';
  if (spout === 'done' && before !== undefined && now < before) return 'once';
  return undefined;
}
