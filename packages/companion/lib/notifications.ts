import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { kv } from './kv';
import { ink } from './theme';

/**
 * Notifications, the phone's side (docs/companion.md, "Notifications: Beluga Push"). Phase 2 adds
 * the relay; for now this keeps your choices, asks Android for permission, and makes the channels
 * the pushes will use, so a Mac can start sending as soon as the relay exists. While the link is
 * open the Mac sends `nudge` frames instead, shown in the app (lib/store.ts).
 */
export interface NotifyPrefs {
  readonly needsYou: boolean;
  readonly done: boolean;
  readonly mentions: boolean;
}
const DEFAULTS: NotifyPrefs = { needsYou: true, done: true, mentions: true };

export const prefs = (): NotifyPrefs => ({ ...DEFAULTS, ...(kv.get<Partial<NotifyPrefs>>('notify') ?? {}) });
export const setPrefs = (p: NotifyPrefs): void => kv.set('notify', p);

export async function permission(ask: boolean): Promise<'granted' | 'denied' | 'unsupported'> {
  if (Platform.OS === 'web') return 'unsupported';
  try {
    const now = await Notifications.getPermissionsAsync();
    if (now.granted || !ask) return now.granted ? 'granted' : 'denied';
    const r = await Notifications.requestPermissionsAsync();
    if (r.granted) await channels();
    return r.granted ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** Android channels: Needs you is high priority (heads-up); the rest are quiet. */
async function channels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('needs-you', { name: 'Needs you', importance: Notifications.AndroidImportance.HIGH, lightColor: ink.peach });
  await Notifications.setNotificationChannelAsync('done', { name: 'Done', importance: Notifications.AndroidImportance.DEFAULT });
  await Notifications.setNotificationChannelAsync('mentions', { name: 'Mentions', importance: Notifications.AndroidImportance.DEFAULT });
}
