import { DEVICE_LINK } from '../lib/link/protocol';

/**
 * A pairing link opened on the phone (`beluga://device#…`): the Mac sends one over the USB cable to
 * pair a plugged-in phone (BLG-190), as if its QR had been scanned. It goes to the pairing screen,
 * which shows the four pictures to check as ever; anything else opens as it would.
 */
export function redirectSystemPath({ path }: { path: string | null; initial: boolean }): string | null {
  if (path && DEVICE_LINK.test(path)) return `/pair?link=${encodeURIComponent(path)}`;
  return path;
}
