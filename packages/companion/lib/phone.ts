import { Platform } from 'react-native';
import { phoneControl, type AdbPorts } from '../modules/phone-control';
import type { PhoneControl as PhoneControlState, PhoneOp } from '../../../src/companion/protocol';
import { kv } from './kv';

/**
 * Your Mac using this phone (docs/companion.md, "Your phone, from your Mac", BLG-150). Off by
 * default; the user turns it on with one switch ("Let your Mac use this phone"), which also turns
 * on Stay connected so the Mac can reach the phone in the background. The Mac decides how freely to
 * act (Off · Ask · Use · Full) on its side; the phone only says what it *allows at all* and how it
 * can be reached. Android only.
 */

export const phoneControlAvailable = (): boolean => Platform.OS === 'android' && phoneControl.available;
/** The phone's own switch: the user has allowed their Mac to use this phone. */
export const phoneAllowed = (): boolean => phoneControlAvailable() && kv.get<boolean>('control-allowed') === true;
export const setPhoneAllowed = (on: boolean): void => kv.set('control-allowed', on);

let adbPorts: AdbPorts = {};
let discovering = false;

/** Start/stop watching for this phone's own Wireless-debugging port over mDNS. */
export function watchAdb(on: boolean, onChange: () => void): () => void {
  if (!phoneControlAvailable()) return () => {};
  const off = phoneControl.onAdbPorts((p) => {
    adbPorts = p;
    onChange();
  });
  if (on && !discovering) {
    discovering = true;
    phoneControl.startAdbDiscovery();
  } else if (!on && discovering) {
    discovering = false;
    phoneControl.stopAdbDiscovery();
  }
  return off;
}

/** This phone's own Wi-Fi IPv4 address (for the Mac's adb on the same network), or undefined. */
function wifiIp(): string | undefined {
  // The worklet knows the network; the app asks the OS. Left to the native module's device info,
  // which includes it when on Wi-Fi; undefined otherwise (the tunnel still works from anywhere).
  const info = phoneControl.deviceInfo();
  const ip = info && typeof info.wifiIp === 'string' ? info.wifiIp : undefined;
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined;
}

/** What this phone lets its Mac do and how it can be reached, for the `control` frame. */
export function controlState(): PhoneControlState {
  const info = phoneControl.deviceInfo() ?? {};
  const device = {
    model: String(info.model ?? 'Android'),
    manufacturer: String(info.manufacturer ?? ''),
    android: String(info.android ?? ''),
    sdk: Number(info.sdk ?? 0),
    w: Number(info.w ?? 1080),
    h: Number(info.h ?? 2400),
  };
  const ip = wifiIp();
  return {
    allowed: phoneAllowed(),
    accessibility: phoneControl.accessibilityEnabled(),
    screenshots: phoneControl.canScreenshot(),
    adb: { on: adbPorts.port !== undefined, ...(adbPorts.port ? { port: adbPorts.port } : {}), ...(adbPorts.pairing ? { pairing: adbPorts.pairing } : {}) },
    ...(ip ? { wifi: { ip } } : {}),
    device,
  };
}

/** Run one op the Mac asked for (a `req`), returning its result (throws with a message on failure). */
export async function runOp(op: PhoneOp, args: Record<string, unknown>): Promise<unknown> {
  if (!phoneAllowed()) throw new Error('This phone hasn’t allowed its Mac to use it');
  if (op !== 'info' && op !== 'apps' && !phoneControl.accessibilityEnabled()) throw new Error('Turn on Accessibility for Beluga on the phone');
  return phoneControl.perform(op, args);
}

/** The "Your Mac is using this phone" notification while a run is acting (with Stop). */
export function controlNote(on: boolean, text = 'Your Mac is using this phone'): void {
  if (!phoneControlAvailable()) return;
  if (on) phoneControl.startControlNote(text);
  else phoneControl.stopControlNote();
}

export const openAccessibilitySettings = (): void => phoneControl.openAccessibilitySettings();
export const onAccessibilityChange = (fn: () => void): (() => void) => (phoneControlAvailable() ? phoneControl.onAccessibilityChange(fn) : () => {});
