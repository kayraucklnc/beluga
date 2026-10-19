import { z } from 'zod';
import { AUTO_COMPACT_DEFAULT, AUTO_COMPACT_MAX, AUTO_COMPACT_MIN } from './context-usage.js';
import { coercePerKind, coerceSound, DEFAULT_SOUND, DEFAULT_VOLUME, PerKindSounds, SoundChoice } from './notify-sound.js';

// Settings as data (no file access), so the reducer and the clients can use them anywhere.

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
  /** The sound notifications make (was on/off: `true` reads as the default sound, `false` as none). */
  sound: z.preprocess((v) => (v === undefined ? v : coerceSound(v)), SoundChoice).default(DEFAULT_SOUND),
  /** How loud Klaud's own sounds (8-bit, generated) are, 0–1. Mac sounds play at the system's alert volume. */
  soundVolume: z.number().min(0).max(1).default(DEFAULT_VOLUME),
  /** A sound for each kind of notification (`null`: the same sound for all). */
  perKind: z.preprocess((v) => (v === undefined ? v : coercePerKind(v)), PerKindSounds.partial().nullable()).default(null),
  /** Generated sounds you kept (their seeds), to pick from again. */
  madeSounds: z.array(z.number().int().min(0).max(0xffffffff)).max(12).default([]),
  /** Claude finished (or stopped) in a workspace you're not looking at. */
  done: z.boolean().default(true),
  /** Claude asks a question, proposes a plan, or needs an approval. */
  needsYou: z.boolean().default(true),
  /** Errors, merge conflicts, failed setup scripts. */
  problems: z.boolean().default(true),
  /** Someone joins, leaves, invites you, or hands work to you. */
  people: z.boolean().default(true),
  /** A pull request was opened or its checks finished. */
  pr: z.boolean().default(true),
  /** Someone mentions you (@name), or writes to you when it's just the two of you. */
  mentions: z.boolean().default(true),
  /** Background work finishes: a task Claude runs in the background, a new worktree's setup. */
  background: z.boolean().default(true),
  /** Desktop notifications only while no klaud window is in front. */
  onlyAway: z.boolean().default(false),
  /** Do Not Disturb: no desktop notifications (the inbox still fills). Ends at `until` (ms), or when you turn it off. */
  dnd: z.object({ until: z.number().int().positive().optional() }).nullable().default(null),
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
  /** Compact a conversation on its own when its context is nearly full (the chat stays on screen). */
  autoCompact: z.boolean().default(true),
  /** How full (percent) a conversation gets before it's compacted. */
  autoCompactAt: z.number().int().min(AUTO_COMPACT_MIN).max(AUTO_COMPACT_MAX).catch(AUTO_COMPACT_DEFAULT),
  /** Claude keeps screenshots and scratch output in the workspace's git-ignored `.klaud/scratch/` folder. */
  scratchFolder: z.boolean().default(true),
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
  /** Start it as a login shell (reads your profile, e.g. ~/.zprofile). */
  shellLogin: z.boolean().default(true),
  /** Extra arguments for the shell, after -l. */
  shellArgs: z.array(z.string().max(200)).max(20).default([]),
  /** Be on the klaud network (friends, groups, presence) while the Mac app's daemon runs. Off by default for now. */
  network: z.boolean().optional(),
  /** "Ask me for…": a short note friends' Claudes see on your card (the gateway, Mac app). */
  askMeFor: z.string().max(280).optional(),
  /** What friends' Claudes may do here, by trust level (checked fully in core/gateway/access.ts). */
  capabilities: z.object({ levels: z.record(z.string(), z.record(z.string(), z.string())).optional(), folders: z.array(z.string().max(4096)).max(20).optional() }).optional(),
});
export type Settings = z.infer<typeof Settings>;
