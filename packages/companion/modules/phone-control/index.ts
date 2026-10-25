import { requireOptionalNativeModule } from 'expo';

/**
 * Your Mac using this phone (BLG-150), the native side: an Android Accessibility service that reads
 * the screen and acts on it, a MediaProjection-free screenshot (takeScreenshot, API 30+), finding
 * this phone's own Wireless-debugging port over mDNS, and a visible "Your Mac is using this phone"
 * notification with Stop. Nothing on iOS or the web: there `available` is false and the rest do
 * nothing. The Kotlin is in modules/phone-control/android.
 *
 * One entry point does the work: `perform(op, argsJson)` runs an op (the protocol's PHONE_OPS) and
 * returns its result as JSON — so the shapes stay in sync with src/companion/protocol.ts, not with
 * a dozen native signatures.
 */
interface Native {
  /** Run one op (see PHONE_OPS); `args` is JSON, the result is JSON (throws with a message on failure). */
  perform(op: string, args: string): Promise<string>;
  /** The Accessibility service is on for Beluga. */
  accessibilityEnabled(): boolean;
  /** Screenshots without adb are possible (the service is connected and Android is 11+). */
  canScreenshot(): boolean;
  /** This phone in a few facts (model, manufacturer, android, sdk, w, h), as JSON. */
  deviceInfo(): string;
  /** Open Android's Accessibility settings so the user can turn Beluga on. */
  openAccessibilitySettings(): void;
  /** The "Your Mac is using this phone" foreground notification with Stop (while a run is acting). */
  startControlNote(text: string): void;
  stopControlNote(): void;
  /** Watch for this phone's own Wireless-debugging service over mDNS → 'adb' events { port, pairing }. */
  startAdbDiscovery(): void;
  stopAdbDiscovery(): void;
  addListener(event: string, listener: (payload: unknown) => void): { remove(): void };
}

const native = requireOptionalNativeModule<Native>('PhoneControl');

export interface AdbPorts {
  readonly port?: number;
  readonly pairing?: number;
}

export const phoneControl = {
  available: native !== null,
  perform: async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!native) throw new Error('Phone control isn’t available on this device');
    const out = await native.perform(op, JSON.stringify(args));
    return out ? (JSON.parse(out) as unknown) : {};
  },
  accessibilityEnabled: (): boolean => native?.accessibilityEnabled() ?? false,
  canScreenshot: (): boolean => native?.canScreenshot() ?? false,
  deviceInfo: (): Record<string, unknown> | undefined => {
    try {
      return native ? (JSON.parse(native.deviceInfo()) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  },
  openAccessibilitySettings: (): void => native?.openAccessibilitySettings(),
  startControlNote: (text: string): void => native?.startControlNote(text),
  stopControlNote: (): void => native?.stopControlNote(),
  startAdbDiscovery: (): void => native?.startAdbDiscovery(),
  stopAdbDiscovery: (): void => native?.stopAdbDiscovery(),
  /** mDNS found (or lost) this phone's debugging ports. */
  onAdbPorts: (fn: (ports: AdbPorts) => void): (() => void) => {
    const sub = native?.addListener('adb', (p) => fn((p ?? {}) as AdbPorts));
    return () => sub?.remove();
  },
  /** The Accessibility service turned on or off, or the screen it sees changed. */
  onAccessibilityChange: (fn: () => void): (() => void) => {
    const sub = native?.addListener('accessibility', () => fn());
    return () => sub?.remove();
  },
};
