import type { Workspace } from './types.js';

// Browser-safe (the Mac app uses it): no Node imports.

export type WorktreeOrigin = 'beluga' | 'agent' | 'external';

const AGENT_DIR = /[\\/]\.claude[\\/]worktrees[\\/]/;
const CONDUCTOR_DIR = /[\\/]conductor[\\/]workspaces[\\/][^\\/]+[\\/][^\\/]+/;

/** Who made a workspace: Beluga (incl. main and chats), a Claude Code sub-agent, or another tool. */
export function worktreeOrigin(ws: Pick<Workspace, 'external' | 'path'>): WorktreeOrigin {
  if (!ws.external) return 'beluga';
  return AGENT_DIR.test(ws.path) ? 'agent' : 'external';
}

/**
 * Which tool made a worktree Beluga didn't (Conductor's folders, Claude Code's, or anything else).
 * Used to pick the right conversation and to keep another app's live workspaces safe; the Mac
 * app never shows the tool's name, only the worktree's name and where it is.
 */
export type WorktreeSource = 'conductor' | 'claude' | 'other';

/** The source from the folder alone (Conductor's and Claude Code's own folders); the rest is "other" until looked up. */
export function sourceFromPath(dir: string): WorktreeSource {
  if (CONDUCTOR_DIR.test(dir)) return 'conductor';
  if (AGENT_DIR.test(dir)) return 'claude';
  return 'other';
}

/** Who made a worktree, in words. */
export interface OriginInfo {
  readonly source: WorktreeSource;
  /** "Made outside Beluga", "Made by Claude in “RC-210 epic”"… (never another app's name). */
  readonly label: string;
  readonly detail: string;
}

export interface OriginFacts {
  readonly path: string;
  /** What Conductor's own data says about it. */
  readonly conductor?: { readonly name: string; readonly state?: string; readonly prTitle?: string };
  /** The Claude Code conversation that ran `git worktree add` for it. */
  readonly creator?: { readonly title?: string; readonly cwd?: string };
}

const lastPart = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Label a worktree Beluga didn't make by what made it (another app stays unnamed). */
export function describeOrigin(f: OriginFacts): OriginInfo {
  const source = sourceFromPath(f.path);
  if (f.conductor || source === 'conductor') {
    const state = f.conductor?.state === 'archived' ? 'The app that made it put it away, but its folder is still here.' : 'Another app made it and still uses it; you can keep working in it from either.';
    return { source: 'conductor', label: 'Made outside Beluga', detail: f.conductor?.prTitle ? `${state} Pull request: ${f.conductor.prTitle}` : state };
  }
  if (source === 'claude') return { source: 'claude', label: 'Claude Code sub-agent', detail: 'A Claude Code agent made it to work in isolation (in .claude/worktrees). It usually isn’t needed once that agent finished.' };
  if (f.creator) {
    const where = f.creator.cwd ? ` That conversation ran in ${lastPart(f.creator.cwd)}.` : '';
    return { source: 'claude', label: f.creator.title ? `Made by Claude in “${f.creator.title}”` : 'Made by a Claude Code conversation', detail: `A Claude Code conversation ran git worktree add for it.${where}` };
  }
  return { source: 'other', label: 'Made outside Beluga', detail: 'Made by hand, by a script or by another tool (Beluga couldn’t find a Claude Code conversation that made it).' };
}
