import type { Status } from './git.js';

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
}

export interface ProjectsConfig {
  /** Parent folders scanned for git projects. */
  readonly roots: readonly string[];
  /** Individually added projects. */
  readonly projects: readonly string[];
  /** Projects you chose to hide. */
  readonly hidden: readonly string[];
}
