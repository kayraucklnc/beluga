import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { stayConnected } from '../modules/stay-connected';
import { kv } from './kv';
import { prefs } from './notifications';

/**
 * Stay connected (docs/companion.md, "Staying connected", BLG-128): off by default. On, the link
 * stays open with the app in the background and the screen off (a foreground service holds the
 * process, modules/stay-connected), the Mac sends nothing but nudges (the phone unsubscribes from
 * every view while away), and each nudge becomes a notification here. Android only.
 */

export const stayAvailable = (): boolean => Platform.OS === 'android' && stayConnected.available;
export const stayOn = (): boolean => stayAvailable() && kv.get<boolean>('stay') === true;
export const setStay = (on: boolean): void => kv.set('stay', on);

let shown: string | undefined;

/** The service runs (saying `text` in its quiet notification) or doesn't. */
export function stayService(text: string | undefined, force = false): void {
  if (!stayAvailable()) return;
  // Forced from the front: a start refused in the background happens now.
  if (text === shown && !force) return;
  shown = text;
  if (text) stayConnected.start(text);
  else stayConnected.stop();
}

export const batteryUnrestricted = (): boolean => stayConnected.unrestricted();
export const askBatteryUnrestricted = (): void => stayConnected.askUnrestricted();

const CHANNEL: Record<'needsYou' | 'done' | 'mentions', string> = { needsYou: 'needs-you', done: 'done', mentions: 'mentions' };

/** A nudge that came while the app is away: a notification, as you set them (Settings › Notify me about). */
export async function notifyNudge(n: { readonly kind: 'needsYou' | 'done' | 'mentions'; readonly title: string; readonly body: string; readonly topic?: string }): Promise<void> {
  if (Platform.OS === 'web' || !prefs()[n.kind]) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: n.title, body: n.body, data: n.topic ? { topic: n.topic } : {}, ...(n.kind === 'needsYou' ? { priority: Notifications.AndroidNotificationPriority.HIGH } : {}) },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL[n.kind] } : null,
    });
  } catch {
    // No permission: the app shows it when you're back.
  }
}
