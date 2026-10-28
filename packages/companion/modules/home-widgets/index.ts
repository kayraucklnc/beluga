import { requireOptionalNativeModule } from 'expo';

/**
 * Board tiles on the Home screen (BLG-361), the native side: an Android widget that draws the
 * tiles the Mac sends in the `widgets` view (modules/home-widgets/android). The app hands each view
 * over as it comes (lib/widgets.ts); the widget keeps it and draws with the app closed. Nothing on
 * iOS or the web: there `available` is false and the rest do nothing.
 */
interface Native {
  /** The `widgets` view as JSON, with `got` (when the phone got it); every widget redraws. */
  set(json: string): void;
  hasIcon(sum: string): boolean;
  /** A project's icon (base64 PNG or JPEG), kept by its checksum. */
  saveIcon(sum: string, b64: string): boolean;
  /** How many Board tile widgets are on the Home screen. */
  placed(): number;
  /** The launcher can place a widget the app asks for. */
  canPin(): boolean;
  /** Ask Android to put this tile ("<dashboardId>/<tileId>") on the Home screen. */
  pin(tileId: string): boolean;
}

const native = requireOptionalNativeModule<Native>('HomeWidgets');

export const homeWidgets = {
  available: native !== null,
  set: (json: string): void => native?.set(json),
  hasIcon: (sum: string): boolean => native?.hasIcon(sum) ?? true,
  saveIcon: (sum: string, b64: string): boolean => native?.saveIcon(sum, b64) ?? false,
  placed: (): number => native?.placed() ?? 0,
  canPin: (): boolean => native?.canPin() ?? false,
  pin: (tileId: string): boolean => native?.pin(tileId) ?? false,
};
