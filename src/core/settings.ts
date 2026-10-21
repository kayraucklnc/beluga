import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { klaudHome } from './home.js';

export { THEMES, TRUST_LEVELS, EFFORTS, NotifySettings, Settings } from '../shared/settings-schema.js';
export type { ThemeName, TrustLevel, Effort } from '../shared/settings-schema.js';
import { NotifySettings, Settings } from '../shared/settings-schema.js';

export const settingsPath = (): string => path.join(klaudHome(), 'settings.json');

export function loadSettings(file: string = settingsPath()): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return Settings.parse({});
  }
  const parsed = Settings.safeParse(raw);
  if (parsed.success) return migrated(parsed.data);
  // Keep every setting that's still valid instead of throwing all of them away.
  const fields = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
  const kept = Object.fromEntries(Object.entries(fields).filter(([k, v]) => k in Settings.shape && Settings.shape[k as keyof Settings].safeParse(v).success));
  return migrated(Settings.parse(kept));
}

/**
 * Auto-compact used to default to on, and every save wrote that default to the file, so an
 * `autoCompact: true` nobody chose can't be told from one somebody did. Only a choice made since
 * (`autoCompactChosen`) keeps it on; everything else reads as off.
 */
function migrated(s: Settings): Settings {
  return s.autoCompact && !s.autoCompactChosen ? { ...s, autoCompact: false } : s;
}

/** Merge and save atomically (write a temp file, then rename). Returns the new settings. */
export function saveSettings(patch: Partial<Settings>, file: string = settingsPath()): Settings {
  // Turning auto-compact on or off here is your choice: remember that it was (see `migrated`).
  const next = Settings.parse({ ...loadSettings(file), ...patch, ...(patch.autoCompact !== undefined ? { autoCompactChosen: true } : {}) });
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}
