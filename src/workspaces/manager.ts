import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { findProjects, isMainCheckout } from './discovery.js';
import * as g from './git.js';
import { type EnvChange, applyEnvChanges, copyEnvFiles, envChanges, envSnapshot } from './env.js';
import { WorkspaceStore } from './store.js';
import type { Project, ProjectGroup, ProjectsConfig, Workspace, WorkspaceRecord } from './types.js';

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

/**
 * Canonical path: resolves symlinks (macOS /var → /private/var) and, via the native call,
 * the on-disk letter case, so ~/projects and ~/Projects on a case-insensitive disk are one folder.
 */
export const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

export const projectId = (root: string): string => createHash('sha1').update(real(root)).digest('hex').slice(0, 10);
const pathId = (p: string): string => `wt-${createHash('sha1').update(real(p)).digest('hex').slice(0, 10)}`;
/** New workspaces get a fresh id, so a reused name never inherits an old record or history. */
const freshId = (): string => `wt-${randomUUID().slice(0, 12)}`;
export const mainId = (root: string): string => `${projectId(root)}:main`;

/** Chats that don't belong to any project live in this pseudo-project. */
export const CHATS_PROJECT = 'chats';

export class WorkspaceError extends Error {}

/**
 * Owns projects and their workspaces on this computer: discovery, worktree
 * lifecycle (create, fork, archive, delete), review, merge, and chat history.
 */
export class WorkspaceManager {
  private records: WorkspaceRecord[];
  private config: ProjectsConfig;
  private projects: Project[] = [];

  constructor(readonly store: WorkspaceStore = new WorkspaceStore()) {
    this.records = store.loadRecords();
    this.config = store.loadConfig();
  }

  get list(): readonly Project[] {
    return this.projects;
  }

  get settings(): ProjectsConfig {
    return this.config;
  }

  find(id: string): Workspace | undefined {
    for (const p of this.projects) {
      const ws = p.workspaces.find((w) => w.id === id);
      if (ws) return ws;
    }
    return undefined;
  }

  private require(id: string): Workspace {
    const ws = this.find(id);
    if (!ws) throw new WorkspaceError('That workspace no longer exists');
    return ws;
  }

  private projectOf(ws: Workspace): Project {
    const p = this.projects.find((x) => x.id === ws.projectId);
    if (!p) throw new WorkspaceError('Project not found');
    return p;
  }

  private saveRecord(record: WorkspaceRecord): void {
    this.records = [...this.records.filter((r) => r.id !== record.id), record];
    this.store.saveRecords(this.records);
  }

  private patchRecord(id: string, patch: Partial<WorkspaceRecord>): void {
    const existing = this.records.find((r) => r.id === id);
    const ws = this.find(id);
    const base: WorkspaceRecord | undefined = existing ?? (ws ? stripLive(ws) : undefined);
    if (!base) return;
    this.saveRecord({ ...base, ...patch });
    // Reflect the change immediately, without waiting for the next refresh.
    this.projects = this.projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  }

  // ---------------------------------------------------------------- projects

  addProject(dir: string): string {
    const root = path.resolve(dir);
    if (!isMainCheckout(root)) throw new WorkspaceError(`${root} is not a git project (no .git folder)`);
    this.config = { ...this.config, projects: [...new Set([...this.config.projects, root])], hidden: this.config.hidden.filter((h) => h !== root) };
    this.store.saveConfig(this.config);
    return projectId(root);
  }

  addFolder(dir: string): number {
    const root = path.resolve(dir);
    if (!existsSync(root)) throw new WorkspaceError(`${root} doesn't exist`);
    this.config = { ...this.config, roots: [...new Set([...this.config.roots, root])] };
    this.store.saveConfig(this.config);
    return findProjects([root]).length;
  }

  get groups(): readonly ProjectGroup[] {
    return this.config.groups ?? [];
  }

  /** Put a project in a group (creating it), or take it out with `group` undefined. */
  setGroup(projectId: string, group: string | undefined): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('Project not found');
    const name = group?.trim().slice(0, 30);
    const others = (this.config.groups ?? []).map((g) => ({ ...g, projects: g.projects.filter((r) => r !== project.root) }));
    const groups = name
      ? others.some((g) => g.name === name)
        ? others.map((g) => (g.name === name ? { ...g, projects: [...g.projects, project.root] } : g))
        : [...others, { name, projects: [project.root] }]
      : others;
    this.config = { ...this.config, groups: groups.filter((g) => g.projects.length > 0) };
    this.store.saveConfig(this.config);
  }

  hideProject(id: string): void {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return;
    this.config = {
      ...this.config,
      projects: this.config.projects.filter((p) => p !== project.root),
      hidden: [...new Set([...this.config.hidden, project.root])],
    };
    this.store.saveConfig(this.config);
  }

  /** Re-scan projects and worktrees and refresh git status for every workspace. */
  async refresh(): Promise<readonly Project[]> {
    const roots = [...new Set([...findProjects(this.config.roots), ...this.config.projects].map(real))].filter(
      (r) => !this.config.hidden.includes(r) && existsSync(r),
    );
    const loaded = await Promise.all(roots.map((root) => this.loadProject(root)));
    // Same-named projects (e.g. two clones) get their parent folder added so you can tell them apart.
    const counts = new Map<string, number>();
    for (const p of loaded) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const named = loaded
      .map((p) => ((counts.get(p.name) ?? 0) > 1 ? { ...p, name: `${p.name} (${path.basename(path.dirname(p.root))})` } : p))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.projects = [this.chatsProject(), ...named];
    return this.projects;
  }

  /** Stand-alone Claude chats, always listed first. */
  private chatsProject(): Project {
    const workspaces = this.records
      .filter((r) => r.projectRoot === '')
      .map((r): Workspace => ({ ...r, projectId: CHATS_PROJECT, external: false }))
      .sort(order);
    return { id: CHATS_PROJECT, name: 'Chats', root: '', base: '', workspaces };
  }

  private async loadProject(root: string): Promise<Project> {
    const id = projectId(root);
    const name = path.basename(root);
    try {
      const base = await g.defaultBase(root);
      const trees = await g.listWorktrees(root);
      const records = this.records.filter((r) => r.projectRoot === root);
      const workspaces: Workspace[] = [];
      for (const tree of trees) {
        const isMain = real(tree.path) === real(root);
        const rec = isMain ? records.find((r) => r.kind === 'main') : records.find((r) => r.kind === 'worktree' && real(r.path) === real(tree.path));
        const record: WorkspaceRecord = rec ?? {
          id: isMain ? mainId(root) : pathId(tree.path),
          projectRoot: root,
          name: isMain ? 'main' : path.basename(tree.path),
          path: tree.path,
          kind: isMain ? 'main' : 'worktree',
          createdAt: 0,
        };
        workspaces.push({ ...record, branch: tree.branch ?? record.branch, base: record.base ?? base, projectId: id, external: !rec && !isMain });
      }
      for (const rec of records) {
        if (rec.kind === 'chat' || (rec.archived && rec.kind === 'worktree')) workspaces.push({ ...rec, projectId: id, external: false });
      }
      const withStatus = await Promise.all(
        workspaces.map(async (w) => (w.archived || w.kind === 'chat' ? w : { ...w, status: await g.status(w.path, w.kind === 'main' ? undefined : w.base).catch(() => undefined) })),
      );
      return { id, name, root, base, workspaces: withStatus.sort(order) };
    } catch (err) {
      return { id, name, root, base: 'HEAD', workspaces: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------- workspaces

  /** New worktree on a fresh branch from the latest origin default branch. */
  async createWorktree(projectIdOrRoot: string, name: string): Promise<Workspace> {
    const project = this.projects.find((p) => p.id === projectIdOrRoot || p.root === projectIdOrRoot);
    if (!project) throw new WorkspaceError('Project not found');
    const s = slug(name);
    const dir = this.freeDir(project, s);
    const branch = await this.freeBranch(project.root, `klaude/${s}`);
    await g.addWorktree(project.root, dir, branch, project.base);
    await g.excludeKlaudeDir(dir);
    await copyEnvFiles(project.root, dir);
    const record: WorkspaceRecord = { id: freshId(), projectRoot: project.root, name: s, path: dir, kind: 'worktree', branch, base: project.base, createdAt: Date.now(), envSnapshot: await envSnapshot(dir) };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** A folder for a new worktree that no live or archived workspace uses (adds -2, -3…). */
  private freeDir(project: Project, name: string): string {
    const parent = path.join(this.store.workspacesDir, `${slug(project.name)}-${project.id.slice(0, 4)}`);
    mkdirSync(parent, { recursive: true });
    const base = real(parent);
    for (let i = 1; ; i++) {
      const dir = path.join(base, i === 1 ? name : `${name}-${i}`);
      if (!existsSync(dir) && !this.records.some((r) => real(r.path) === dir)) return dir;
    }
  }

  private async freeBranch(repo: string, wanted: string): Promise<string> {
    for (let i = 1; ; i++) {
      const name = i === 1 ? wanted : `${wanted}-${i}`;
      try {
        await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      } catch {
        return name;
      }
    }
  }

  /** A conversation with Claude in the project's main folder, no worktree needed. */
  private get chatsDir(): string {
    return path.join(this.store.workspacesDir, '..', 'chats');
  }

  async createChat(projectIdOrRoot: string, title: string, inDir?: string): Promise<Workspace> {
    if (projectIdOrRoot === CHATS_PROJECT) return this.createStandaloneChat(title, inDir);
    const project = this.projects.find((p) => p.id === projectIdOrRoot || (p.root !== '' && p.root === projectIdOrRoot));
    if (!project) throw new WorkspaceError('Project not found');
    const record: WorkspaceRecord = { id: `chat-${randomUUID().slice(0, 8)}`, projectRoot: project.root, name: title.trim().slice(0, 40) || 'chat', path: project.root, kind: 'chat', createdAt: Date.now() };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** A Claude chat with no project: its own scratch folder for anything Claude makes. */
  async createStandaloneChat(title: string, inDir?: string): Promise<Workspace> {
    const id = `chat-${randomUUID().slice(0, 8)}`;
    // Runs in the folder you give it (e.g. where you started klaude), or its own scratch folder.
    const dir = inDir ?? path.join(this.chatsDir, id);
    mkdirSync(dir, { recursive: true });
    const record: WorkspaceRecord = { id, projectRoot: '', name: title.trim().slice(0, 40) || 'chat', path: real(dir), kind: 'chat', createdAt: Date.now() };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** Copy a workspace into a new worktree that starts from its current state, with its conversation. */
  async fork(id: string, name: string): Promise<Workspace> {
    const source = this.require(id);
    const project = this.projectOf(source);
    const s = slug(name);
    const dir = this.freeDir(project, s);
    const from = source.kind === 'chat' ? project.base : (source.branch ?? 'HEAD');
    const branch = await this.freeBranch(project.root, `klaude/${s}`);
    await g.addWorktree(project.root, dir, branch, from);
    await g.excludeKlaudeDir(dir);
    await copyEnvFiles(source.kind === 'chat' ? project.root : source.path, dir);
    const record: WorkspaceRecord = {
      id: freshId(),
      projectRoot: project.root,
      name: s,
      path: dir,
      kind: 'worktree',
      branch,
      base: source.base ?? project.base,
      createdAt: Date.now(),
      forkedFrom: source.id,
      forkFromSession: source.sessionId,
      envSnapshot: await envSnapshot(dir),
    };
    this.saveRecord(record);
    if (existsSync(this.store.historyFile(source.id))) copyFileSync(this.store.historyFile(source.id), this.store.historyFile(record.id));
    await this.refresh();
    return this.require(record.id);
  }

  /** Remove the worktree folder but keep its branch and conversation, so it can be revisited. */
  async archive(id: string, force = false): Promise<void> {
    const ws = this.require(id);
    if (ws.kind === 'main') throw new WorkspaceError("The main folder can't be archived");
    if (ws.kind === 'worktree') {
      if (!force && (ws.status?.changed ?? 0) > 0) throw new WorkspaceError(`${ws.name} has ${ws.status?.changed} uncommitted file(s). Commit them or archive anyway.`);
      await g.removeWorktree(ws.projectRoot, ws.path, force);
    }
    this.patchRecord(id, { archived: true });
    await this.refresh();
  }

  /** Bring an archived worktree back from its branch. */
  async restore(id: string): Promise<void> {
    const ws = this.require(id);
    if (!ws.archived) return;
    if (ws.kind === 'worktree' && ws.branch) {
      mkdirSync(path.dirname(ws.path), { recursive: true });
      await g.git(ws.projectRoot, ['worktree', 'add', ws.path, ws.branch]);
    }
    this.patchRecord(id, { archived: false });
    await this.refresh();
  }

  /** Permanently delete: worktree folder, its branch, and its conversation. */
  async remove(id: string): Promise<void> {
    const ws = this.require(id);
    if (ws.kind === 'main') throw new WorkspaceError("The main folder can't be deleted from klaude");
    if (ws.kind === 'worktree') {
      // Never force-remove worktrees made by other tools: their uncommitted work isn't ours to discard.
      if (!ws.archived && existsSync(ws.path)) await g.removeWorktree(ws.projectRoot, ws.path, !ws.external);
      if (ws.branch && !ws.external) await g.deleteBranch(ws.projectRoot, ws.branch).catch(() => undefined);
    }
    rmSync(this.store.historyFile(id), { force: true });
    // Only ever delete klaude's own scratch folders, never a folder you started a chat in.
    if (ws.projectRoot === '' && real(ws.path).startsWith(real(this.chatsDir) + path.sep)) rmSync(ws.path, { recursive: true, force: true });
    this.records = this.records.filter((r) => r.id !== id);
    this.store.saveRecords(this.records);
    await this.refresh();
  }

  rename(id: string, name: string): void {
    this.patchRecord(id, { name: name.trim().slice(0, 40) || this.require(id).name });
  }

  rememberSession(id: string, sessionId: string): void {
    this.patchRecord(id, { sessionId, forkFromSession: undefined });
  }

  // ---------------------------------------------------------- review & merge

  async review(id: string): Promise<g.Review> {
    const ws = this.require(id);
    return g.review(ws.path, ws.base ?? this.projectOf(ws).base);
  }

  async fileDiff(id: string, file: string): Promise<string> {
    const ws = this.require(id);
    return g.fileDiff(ws.path, ws.base ?? this.projectOf(ws).base, file);
  }

  async commitAll(id: string, message: string): Promise<boolean> {
    const done = await g.commitAll(this.require(id).path, message);
    await this.refresh();
    return done;
  }

  /** Merge a worktree's branch into the project's main checkout. */
  async merge(id: string): Promise<g.MergeResult> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || !ws.branch) throw new WorkspaceError('Only worktrees can be merged');
    if ((ws.status?.changed ?? 0) > 0) throw new WorkspaceError(`${ws.name} has uncommitted changes. Commit them first.`);
    const base = ws.base ?? this.projectOf(ws).base;
    const target = base.startsWith('origin/') ? base.slice('origin/'.length) : base === 'HEAD' ? undefined : base;
    const result = await g.mergeInto(ws.projectRoot, ws.branch, target);
    await this.refresh();
    return result;
  }

  // --------------------------------------------------------------- env files

  /** Env keys/files changed in a worktree compared with the main folder (key names only). */
  envChanges(id: string): EnvChange[] {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || ws.archived || !existsSync(ws.path)) return [];
    return envChanges(ws.path, ws.projectRoot, ws.envSnapshot);
  }

  /** Copy a worktree's env changes back into the main folder. */
  applyEnvBack(id: string): number {
    const ws = this.require(id);
    const changes = this.envChanges(id);
    applyEnvChanges(ws.path, ws.projectRoot, changes);
    return changes.length;
  }

  // ------------------------------------------------------------------ misc

  contextDir(id: string): string {
    const ws = this.require(id);
    return path.join(ws.path, '.klaude');
  }

  openInFinder(id: string): void {
    const ws = this.require(id);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [ws.path], { stdio: 'ignore', detached: true }).unref();
  }

  loadHistory<T>(id: string): T[] {
    return this.store.loadHistory<T>(id);
  }

  saveHistory(id: string, items: readonly unknown[]): void {
    this.store.saveHistory(id, items);
  }
}

function stripLive(ws: Workspace): WorkspaceRecord {
  const { projectId: _p, external: _e, status: _s, ...record } = ws;
  return record;
}

const KIND_ORDER = { main: 0, worktree: 1, chat: 2 } as const;
const order = (a: Workspace, b: Workspace): number =>
  Number(a.archived ?? false) - Number(b.archived ?? false) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.createdAt - a.createdAt || a.name.localeCompare(b.name);
