import type { Status } from './git.js';
import type { DefaultBranch, FetchProblem } from './sync.js';
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
  readonly last?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cost: number };
  /** What each local day ("2026-10-18") added, the last few weeks (see usage-days.ts). */
  readonly days?: Readonly<Record<string, UsageDay>>;
  /** When Claude last reported usage here (epoch ms). */
  readonly lastAt?: number;
}

/** Claude usage on one day: tokens (input, output and cache writes) and estimated cost in USD. */
export interface UsageDay {
  readonly tokens: number;
  readonly cost: number;
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
  /** Archived smartly: how much space it freed, what it kept, and what makes the rest again. */
  readonly archive?: { readonly freedBytes: number; readonly keptBytes: number; readonly remake: readonly string[]; readonly at: number };
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
  /** A conversation started for one job: 'sync_main' is Claude bringing the main folder up to date. */
  readonly purpose?: 'sync_main';
}

/** A workspace as shown in the UI: record + live git status. */
export interface Workspace extends WorkspaceRecord {
  readonly projectId: string;
  /** A worktree that exists in git but wasn't created by Beluga (e.g. by another tool). */
  readonly external: boolean;
  readonly status?: Status;
  /**
   * A project's main folder (its main checkout, or a chat there): questions only. Claude can read
   * and answer but changes nothing; work moves to a new worktree.
   */
  readonly askOnly?: boolean;
  /** Being made: its row and page show at once, while git makes the folder (see core/optimistic.ts). */
  readonly pending?: boolean;
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
  /** The default branch (main or master) against its remote, and fetching it (see sync.ts). */
  readonly sync?: ProjectSync;
}

/** How a project's default branch stands, plus Beluga's fetching of it. */
export interface ProjectSync extends DefaultBranch {
  /** A fetch is running now. */
  readonly fetching?: boolean;
  /** The last fetch failed (cleared by the next one that works). */
  readonly fetchError?: { readonly reason: FetchProblem; readonly message: string; readonly at: number };
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
  /**
   * Projects you removed from Beluga (Delete Project) that a scanned root would otherwise find
   * again. Unlike hidden ones they aren't offered back; adding the project again clears it.
   */
  readonly removed?: readonly string[];
  /** Your own grouping of projects in the sidebar. */
  readonly groups?: readonly ProjectGroup[];
  /**
   * The sidebar's top level in the order you arranged it: project roots and `group:<name>`.
   * Missing until you arrange something (then: projects alphabetically, then groups).
   */
  readonly order?: readonly string[];
  /** Setup / run commands you set per project (by project root), over beluga.json and guesses. */
  readonly scripts?: Readonly<Record<string, ProjectScripts>>;
  /** Setup commands from a project's own beluga.json/conductor.json you allowed to run (by root → command hashes). */
  readonly approvedScripts?: Readonly<Record<string, readonly string[]>>;
}
