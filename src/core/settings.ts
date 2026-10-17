import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { klaudHome } from './home.js';
import { z } from 'zod';

export const THEMES = ['calm', 'light', 'contrast', 'mono'] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * How much you trust someone, from "can't use my Claude" to "do anything without asking".
 * Secrets (.env, keys, .ssh…) stay blocked at every level.
 */
export const TRUST_LEVELS = ['blocked', 'ask', 'trusted', 'full'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Which events can notify you (desktop notification + the in-app inbox). */
export const NotifySettings = z.object({
  /** Show a desktop notification (macOS Notification Center, notify-send on Linux). */
  desktop: z.boolean().default(true),
  sound: z.boolean().default(true),
  /** Claude finished (or stopped) in a workspace you're not looking at. */
  done: z.boolean().default(true),
  /** Claude asks a question, proposes a plan, or needs an approval. */
  needsYou: z.boolean().default(true),
  /** Errors, merge conflicts, failed setup scripts. */
  problems: z.boolean().default(true),
  /** Someone joins, invites you, or hands work to you. */
  people: z.boolean().default(true),
  /** A pull request was opened or its checks finished. */
  pr: z.boolean().default(true),
});
export type NotifySettings = z.infer<typeof NotifySettings>;

const peerKey = z.string().regex(/^[\w-]{8,64}$/);

/** Choices that persist between runs in ~/.klaud/settings.json. */
export const Settings = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/).optional(),
  theme: z.enum(THEMES).default('calm'),
  /** Default trust for people you haven't chosen a level for. Unset until you answer the welcome screen once. */
  policy: z.enum(['ask', 'auto', 'deny']).optional(),
  mouse: z.boolean().default(true),
  tunnel: z.enum(['auto', 'p2p', 'cloudflared', 'ngrok', 'none']).default('auto'),
  /** Whether your own Claude asks before shell commands and other risky actions. */
  selfApproval: z.enum(['never', 'ask']).default('never'),
  notify: NotifySettings.default(NotifySettings.parse({})),
  /** Model for new conversations (unset: Claude Code's default). */
  model: z.string().regex(/^[\w.:[\]-]{1,80}$/).optional(),
  effort: z.enum(EFFORTS).optional(),
  /** Run the project's setup script (e.g. npm install) in every new worktree. */
  autoSetup: z.boolean().default(true),
  /** Show how full each conversation's context is. */
  contextMeter: z.boolean().default(true),
  /** How much of Claude's sub-agent work the chat shows. */
  subagents: z.enum(['full', 'compact', 'hidden']).default('full'),
  /** Workspace buttons you chose to hide from the top bar. */
  hiddenButtons: z.array(z.string().max(40)).max(40).default([]),
  /** Friends may ask to start a worktree (and hand work over) on this computer; you still approve each one. */
  friendWorktrees: z.enum(['ask', 'off']).default('ask'),
  /** People you chose a trust level for (by their key-derived id). */
  people: z.record(peerKey, z.object({ name: z.string().max(32), trust: z.enum(TRUST_LEVELS) })).default({}),
  /** Shell for the built-in terminal (default: $SHELL). */
  shell: z.string().max(200).optional(),
});
export type Settings = z.infer<typeof Settings>;

export const settingsPath = (): string => path.join(klaudHome(), 'settings.json');

export function loadSettings(file: string = settingsPath()): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return Settings.parse({});
  }
  const parsed = Settings.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Keep every setting that's still valid instead of throwing all of them away.
  const fields = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
  const kept = Object.fromEntries(Object.entries(fields).filter(([k, v]) => k in Settings.shape && Settings.shape[k as keyof Settings].safeParse(v).success));
  return Settings.parse(kept);
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
