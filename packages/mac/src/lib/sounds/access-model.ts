/** Whether macOS lets Klaud notify (System Settings › Notifications › Klaud). */
export interface NotificationAccess {
  /** `off`: turned off for Klaud; `notAsked`: macOS hasn't asked you yet; `unknown`: can't tell (a dev build, a browser). */
  readonly state: 'allowed' | 'off' | 'notAsked' | 'unknown';
  /** Banners or alerts are on (otherwise they only collect in Notification Center). */
  readonly alerts: boolean;
  /** "Play sound for notifications" is on. */
  readonly sound: boolean;
  /**
   * A Focus (Do Not Disturb, Work…) is on and holding banners. macOS only tells apps with Full
   * Disk Access, so usually `unknown` (missing from an older app shell: `unknown` too).
   */
  readonly focus?: 'on' | 'off' | 'unknown';
  /** The Focus that's on ("Do Not Disturb"). */
  readonly focusName?: string;
}

export const UNKNOWN_ACCESS: NotificationAccess = { state: 'unknown', alerts: true, sound: true, focus: 'unknown' };

/** What fixes it: System Settings › Notifications › Klaud, Focus settings, or macOS's own prompt. */
export type AccessAction = 'notifications' | 'focus' | 'ask';

export const ACTION_LABELS: Readonly<Record<AccessAction, string>> = {
  notifications: 'Open Notification Settings',
  focus: 'Open Focus Settings',
  ask: 'Allow Notifications…',
};

/** Klaud's own switches that keep banners away (Settings › Notifications, above). */
export interface OwnSettings {
  readonly desktop: boolean;
  /** Klaud's Do Not Disturb, while it's on ("until 3:00 PM"). */
  readonly quietUntil: string | null;
}

/** The line at the top of Settings › Notifications: how things stand, and what to do about it. */
export interface NotifyStatus {
  readonly tone: 'ok' | 'warn' | 'muted';
  /** "Notifications are on", "Blocked by macOS", "Not set up yet"… */
  readonly title: string;
  readonly detail: string;
  /** What to turn on, in one line (only when something is in the way). */
  readonly fix?: string;
  readonly action?: AccessAction;
}

const WHAT_TO_TURN_ON = 'turn on “Allow notifications”, choose “Banners”, and turn on “Play sound for notifications”.';

/** Something in the way, and what it did to a test notification. */
type Block = NotifyStatus & { readonly action: AccessAction; readonly held: string };

/** Turned off, or banners or sound off, for Klaud in System Settings (`null`: none of these). */
function macBlock(a: NotificationAccess): Block | null {
  const action = 'notifications';
  if (a.state === 'off') return { tone: 'warn', title: 'Blocked by macOS', detail: 'macOS isn’t letting Klaud show notifications. The bell in the toolbar still lists everything.', fix: `In System Settings › Notifications › Klaud, ${WHAT_TO_TURN_ON}`, action, held: 'Sent, but macOS blocked it.' };
  if (a.state !== 'allowed') return null;
  if (!a.alerts) return { tone: 'warn', title: 'Banners are off in macOS', detail: 'Klaud’s notifications only collect in Notification Center, without a banner or sound.', fix: 'In System Settings › Notifications › Klaud, choose “Banners” (or “Alerts”).', action, held: 'Sent, but macOS put it straight into Notification Center: banners are off.' };
  if (!a.sound) return { tone: 'warn', title: 'Sounds are off in macOS', detail: 'Banners show, but silently.', fix: 'In System Settings › Notifications › Klaud, turn on “Play sound for notifications”.', action, held: 'Sent. The banner shows, but macOS keeps Klaud’s notifications silent.' };
  return null;
}

/** A Focus that's on (`null`: none is, or macOS won't say). */
function focusBlock(a: NotificationAccess): Block | null {
  if (a.focus !== 'on') return null;
  const name = a.focusName ?? 'A Focus';
  return { tone: 'warn', title: `${name} is on`, detail: 'macOS holds Klaud’s banners in Notification Center and mutes their sound until it ends.', fix: 'Turn it off in Control Center, or add Klaud to this Focus’s “Allowed Apps” in System Settings › Focus.', action: 'focus', held: `Sent, but ${a.focusName ?? 'a Focus'} is holding it in Notification Center, muted.` };
}

/** How things stand, from what macOS says and Klaud's own switches. */
export function notifyStatus(a: NotificationAccess | undefined, own: OwnSettings): NotifyStatus {
  if (!a) return { tone: 'muted', title: 'Checking…', detail: 'Asking macOS whether Klaud may notify you.' };
  const mac = macBlock(a) ?? focusBlock(a);
  if (mac) return mac;
  if (a.state === 'notAsked') return { tone: 'warn', title: 'Not set up yet', detail: 'macOS hasn’t asked you whether Klaud may show notifications.', fix: 'Allow them when macOS asks, then send a test.', action: 'ask' };
  if (!own.desktop) return { tone: 'muted', title: 'Desktop notifications are off', detail: 'Turn them on below. The bell in the toolbar still lists everything.' };
  if (own.quietUntil) return { tone: 'muted', title: 'Klaud’s Do Not Disturb is on', detail: `Banners are paused ${own.quietUntil}. The bell still fills.` };
  if (a.state === 'unknown') return { tone: 'muted', title: 'Can’t check macOS from here', detail: 'This window can’t read System Settings. Send a test to see whether a banner shows.' };
  const detail = 'macOS shows Klaud’s banners and plays their sound.';
  if (a.focus === 'off') return { tone: 'ok', title: 'Notifications are on', detail };
  return { tone: 'ok', title: 'Notifications are on', detail: `${detail} Do Not Disturb or another Focus can still hold them.` };
}

/** What happened to the test, in a sentence, and what to do if it didn't show. */
export interface TestOutcome {
  readonly tone: 'ok' | 'warn';
  readonly text: string;
  readonly action?: AccessAction;
}

/**
 * After a test: whether the banner can have shown. When macOS seems fine, say where to look and
 * what can still hold it (a Focus macOS doesn't tell Klaud about).
 */
export function testOutcome(a: NotificationAccess, soundName: string | null): TestOutcome {
  const heard = soundName ? ` You heard “${soundName}” here.` : '';
  const block = macBlock(a) ?? focusBlock(a);
  if (block) return { tone: 'warn', text: `${block.held}${heard}`, action: block.action };
  if (a.state === 'notAsked') return { tone: 'warn', text: `Sent, but you haven’t allowed Klaud’s notifications in macOS yet.${heard}`, action: 'ask' };
  if (a.focus === 'off') return { tone: 'ok', text: `Sent. Look for the banner at the top right of your screen.${heard}` };
  return { tone: 'ok', text: `Sent. Look for the banner at the top right of your screen.${heard} Nothing? If Do Not Disturb or another Focus is on (the moon in the menu bar), macOS holds it in Notification Center.`, action: 'focus' };
}
