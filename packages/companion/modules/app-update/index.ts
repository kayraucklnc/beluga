import { requireOptionalNativeModule } from 'expo';

/**
 * The phone app updating itself (BLG-426), the native side: download a release's APK, check it,
 * and hand it to Android's installer (modules/app-update/android). Nothing on iOS or the web:
 * there `available` is false. What it's for is in lib/update.ts.
 */
interface Native {
  version(): { name: string; code: number };
  canInstall(): boolean;
  allowInstalls(): void;
  quiet(): boolean;
  metered(): boolean;
  front(on: boolean): void;
  download(url: string, size: number, sha256: string | null, name: string): Promise<string>;
  install(path: string): Promise<void>;
  discard(): void;
  addListener(event: string, listener: (payload: unknown) => void): { remove(): void };
}

/** What Android's installer said: it wants a tap (`confirm`), it's in (`done`), you said no (`aborted`), or it failed. */
export interface InstallStatus {
  readonly status: 'confirm' | 'done' | 'aborted' | 'failed';
  readonly message?: string | null;
}

const native = requireOptionalNativeModule<Native>('AppUpdate');

export const appUpdate = {
  available: native !== null,
  version: (): string | undefined => native?.version().name,
  canInstall: (): boolean => native?.canInstall() ?? false,
  allowInstalls: (): void => native?.allowInstalls(),
  quiet: (): boolean => native?.quiet() ?? false,
  metered: (): boolean => native?.metered() ?? true,
  front: (on: boolean): void => native?.front(on),
  download: (url: string, size: number, sha256: string | undefined, name: string): Promise<string> => (native ? native.download(url, size, sha256 ?? null, name) : Promise.reject(new Error('Not on this phone'))),
  install: (path: string): Promise<void> => (native ? native.install(path) : Promise.reject(new Error('Not on this phone'))),
  discard: (): void => native?.discard(),
  onProgress(fn: (got: number, size: number) => void): () => void {
    const sub = native?.addListener('progress', (p) => {
      const { got, size } = p as { got: number; size: number };
      fn(got, size);
    });
    return () => sub?.remove();
  },
  onStatus(fn: (s: InstallStatus) => void): () => void {
    const sub = native?.addListener('status', (p) => fn(p as InstallStatus));
    return () => sub?.remove();
  },
};
