/** Whether macOS lets Klaud notify (System Settings › Notifications › Klaud). */
export interface NotificationAccess {
  /** `off`: turned off for Klaud; `notAsked`: macOS asks with the first notification; `unknown`: can't tell (a dev build, a browser). */
  readonly state: 'allowed' | 'off' | 'notAsked' | 'unknown';
  /** Banners or alerts are on (otherwise they only collect in Notification Center). */
  readonly alerts: boolean;
  /** "Play sound for notifications" is on. */
  readonly sound: boolean;
}

export const UNKNOWN_ACCESS: NotificationAccess = { state: 'unknown', alerts: true, sound: true };

/** What's wrong, in a sentence, when macOS keeps Klaud's notifications from you (`null`: nothing is). */
export function accessProblem(a: NotificationAccess | undefined): { readonly title: string; readonly detail: string } | null {
  if (!a) return null;
  if (a.state === 'off') return { title: 'Notifications are off for Klaud in System Settings', detail: 'Turn on “Allow notifications” for Klaud. The bell in the toolbar still lists everything.' };
  if (a.state !== 'allowed') return null;
  if (!a.alerts) return { title: 'Klaud’s banners are off in System Settings', detail: 'Notifications only collect in Notification Center. Choose Banners or Alerts for Klaud.' };
  if (!a.sound) return { title: 'Sounds are off for Klaud in System Settings', detail: 'Turn on “Play sound for notifications” for Klaud to hear the sound you pick here.' };
  return null;
}
