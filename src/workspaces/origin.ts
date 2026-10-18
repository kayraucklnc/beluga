import type { Workspace } from './types.js';

// Browser-safe (the Mac app uses it): no Node imports.

export type WorktreeOrigin = 'klaud' | 'agent' | 'external';

const AGENT_DIR = /[\\/]\.claude[\\/]worktrees[\\/]/;
const CONDUCTOR_DIR = /[\\/]conductor[\\/]workspaces[\\/][^\\/]+[\\/][^\\/]+/;

/** Who made a workspace: klaud (incl. main and chats), a Claude Code sub-agent, or another tool. */
export function worktreeOrigin(ws: Pick<Workspace, 'external' | 'path'>): WorktreeOrigin {
  if (!ws.external) return 'klaud';
  return AGENT_DIR.test(ws.path) ? 'agent' : 'external';
}

/** Which tool made a worktree klaud didn't: how the Mac sidebar groups them. */
export type WorktreeSource = 'conductor' | 'claude' | 'other';

/** The source from the folder alone (Conductor's and Claude Code's own folders); the rest is "other" until looked up. */
export function sourceFromPath(dir: string): WorktreeSource {
  if (CONDUCTOR_DIR.test(dir)) return 'conductor';
  if (AGENT_DIR.test(dir)) return 'claude';
  return 'other';
}

/** The sidebar fold for each source: its title and the one line that explains it. */
export const SOURCE_FOLDS: Readonly<Record<WorktreeSource, { readonly title: string; readonly explainer: string }>> = {
  conductor: { title: 'Conductor', explainer: 'Worktrees Conductor made for its workspaces. Their Claude Code conversations show here; Conductor still owns them.' },
  claude: { title: 'Claude Code', explainer: 'Worktrees Claude Code made: by its sub-agents, or by a conversation that ran git worktree add.' },
  other: { title: 'Other Worktrees', explainer: 'Worktrees made outside Klaud, by hand, a script or another tool.' },
};

/** Who made a worktree, in words. */
export interface OriginInfo {
  readonly source: WorktreeSource;
  /** "Conductor workspace “berlin”", "Made by Claude in “RC-210 epic”", "Made outside Klaud"… */
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

/** Label a worktree klaud didn't make by what made it. */
export function describeOrigin(f: OriginFacts): OriginInfo {
  const source = sourceFromPath(f.path);
  if (f.conductor || source === 'conductor') {
    const name = f.conductor?.name ?? lastPart(f.path);
    const state = f.conductor?.state === 'archived' ? 'Archived in Conductor, but its folder is still here.' : 'Conductor made it for one of its workspaces; you can keep working in it from either app.';
    return { source: 'conductor', label: `Conductor workspace “${name}”`, detail: f.conductor?.prTitle ? `${state} Pull request: ${f.conductor.prTitle}` : state };
  }
  if (source === 'claude') return { source: 'claude', label: 'Claude Code sub-agent', detail: 'A Claude Code agent made it to work in isolation (in .claude/worktrees). It usually isn’t needed once that agent finished.' };
  if (f.creator) {
    const where = f.creator.cwd ? ` That conversation ran in ${lastPart(f.creator.cwd)}.` : '';
    return { source: 'claude', label: f.creator.title ? `Made by Claude in “${f.creator.title}”` : 'Made by a Claude Code conversation', detail: `A Claude Code conversation ran git worktree add for it.${where}` };
  }
  return { source: 'other', label: 'Made outside Klaud', detail: 'Made by hand, by a script or by another tool (Klaud couldn’t find a Claude Code conversation that made it).' };
}
