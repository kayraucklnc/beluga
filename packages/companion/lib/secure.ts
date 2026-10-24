import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * The phone's secrets: the pairing (device certificate, the Mac's address) and the device key's
 * seed. Android Keystore-wrapped (expo-secure-store); the iOS Keychain later. On the web (the demo
 * only) there are no secrets worth the name, so localStorage stands in.
 */
const web = Platform.OS === 'web';

export const secure = {
  async get<T>(key: string): Promise<T | undefined> {
    const raw = web ? globalThis.localStorage?.getItem(`beluga-secure:${key}`) : await SecureStore.getItemAsync(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    const raw = JSON.stringify(value);
    if (web) globalThis.localStorage?.setItem(`beluga-secure:${key}`, raw);
    else await SecureStore.setItemAsync(key, raw, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async remove(key: string): Promise<void> {
    if (web) globalThis.localStorage?.removeItem(`beluga-secure:${key}`);
    else await SecureStore.deleteItemAsync(key);
  },
};
