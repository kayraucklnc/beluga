/** The macOS permissions the welcome offers (lib/privacy.ts, src-tauri/src/privacy.rs). */
export type PrivacyPane = 'screen' | 'accessibility' | 'disk' | 'automation';
/** `off`: not allowed (or never asked); `unknown`: macOS won't say. */
export type Grant = 'granted' | 'off' | 'unknown';
export type PrivacyAccess = Readonly<Record<PrivacyPane, Grant>>;
