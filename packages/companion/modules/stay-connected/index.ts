import { requireOptionalNativeModule } from 'expo';

/**
 * Stay connected (BLG-128), the native side: an Android foreground service that keeps the app's
 * process running with the screen off (modules/stay-connected/android). Nothing on iOS or the web:
 * there `available` is false and the rest do nothing.
 */
interface Native {
  start(text: string): void;
  stop(): void;
  unrestricted(): boolean;
  askUnrestricted(): void;
}

const native = requireOptionalNativeModule<Native>('StayConnected');

export const stayConnected = {
  available: native !== null,
  start: (text: string): void => native?.start(text),
  stop: (): void => native?.stop(),
  unrestricted: (): boolean => native?.unrestricted() ?? true,
  askUnrestricted: (): void => native?.askUnrestricted(),
};
