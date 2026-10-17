import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const THEMES = ['calm', 'light', 'contrast', 'mono'] as const;
export type ThemeName = (typeof THEMES)[number];

/** Choices that persist between runs in ~/.klaude/settings.json. */
export const Settings = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/).optional(),
  theme: z.enum(THEMES).default('calm'),
  /** Unset until you answer the welcome screen once. */
  policy: z.enum(['ask', 'auto', 'deny']).optional(),
  mouse: z.boolean().default(true),
  tunnel: z.enum(['auto', 'cloudflared', 'ngrok', 'none']).default('auto'),
  /** Whether your own Claude asks before shell commands and other risky actions. */
  selfApproval: z.enum(['never', 'ask']).default('never'),
});
export type Settings = z.infer<typeof Settings>;

export const settingsPath = (): string => path.join(process.env.KLAUDE_HOME ?? path.join(os.homedir(), '.klaude'), 'settings.json');

export function loadSettings(file: string = settingsPath()): Settings {
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : Settings.parse({});
  } catch {
    return Settings.parse({});
  }
}

/** Merge and save atomically (write a temp file, then rename). Returns the new settings. */
export function saveSettings(patch: Partial<Settings>, file: string = settingsPath()): Settings {
  const next = Settings.parse({ ...loadSettings(file), ...patch });
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}
