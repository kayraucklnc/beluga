import type { Status } from './git.js';
import type { ProjectScripts, ResolvedScripts } from './scripts.js';

/** Claude usage in one workspace, summed over every run. */
export interface WorkspaceUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Estimated cost in USD (what the SDK reports; not a bill). */
  readonly cost: number;
  readonly runs: number;
  /** The SDK reports running totals per conversation; remembered to add only what's new. */
  readonly lastSession?: string;
  readonly lastTotal?: number;
}

export type WorkspaceKind = 'main' | 'worktree' | 'chat';

/** What we remember about a workspace between runs. */
export interface WorkspaceRecord {
  readonly id: string;
  readonly projectRoot: string;
  readonly name: string;
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly branch?: string;
  readonly base?: string;
  readonly createdAt: number;
  readonly archived?: boolean;
  /** Claude conversation to resume in this workspace. */
  readonly sessionId?: string;
  /** Set on forks until their first run, so Claude branches the parent's conversation. */
  readonly forkFromSession?: string;
  readonly forkedFrom?: string;
  /** Hashes of env files copied into this worktree at creation, to detect changes later. */
  readonly envSnapshot?: Readonly<Record<string, string>>;
  /** Model picked for this conversation (unset: your default). */
  readonly model?: string;
  readonly usage?: WorkspaceUsage;
  /** Handed off to a friend (their name), who continues it on their computer. */
  readonly handedTo?: string;
  /** Came from a friend's handoff (their name). */
  readonly handedFrom?: string;
}

/** A workspace as shown in the UI: record + live git status. */
export interface Workspace extends WorkspaceRecord {
  readonly projectId: string;
  /** A worktree that exists in git but wasn't created by klaude (e.g. by another tool). */
  readonly external: boolean;
  readonly status?: Status;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly base: string;
  readonly workspaces: readonly Workspace[];
  readonly error?: string;
  /** Setup and run commands that apply to this project. */
  readonly scripts?: ResolvedScripts;
}

export interface ProjectGroup {
  readonly name: string;
  /** Project roots in this group. */
  readonly projects: readonly string[];
}

export interface ProjectsConfig {
  /** Parent folders scanned for git projects. */
  readonly roots: readonly string[];
  /** Individually added projects. */
  readonly projects: readonly string[];
  /** Projects you chose to hide. */
  readonly hidden: readonly string[];
  /** Your own grouping of projects in the sidebar. */
  readonly groups?: readonly ProjectGroup[];
  /** Setup / run commands you set per project (by project root), over klaude.json and guesses. */
  readonly scripts?: Readonly<Record<string, ProjectScripts>>;
}
