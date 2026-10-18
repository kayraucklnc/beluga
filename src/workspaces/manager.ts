import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { findProjects, isMainCheckout } from './discovery.js';
import * as g from './git.js';
import { type EnvChange, applyEnvChanges, copyEnvFiles, envChanges, envSnapshot } from './env.js';
import { WorkspaceStore } from './store.js';
import { worktreeOrigin } from './origin.js';
import { addDay, dayKey } from './usage-days.js';
import type { Project, ProjectGroup, ProjectsConfig, Workspace, WorkspaceRecord, WorkspaceUsage } from './types.js';
import { ArrangeError, type Item, type Layout, MAX_GROUP_NAME, arrangedOrder, groupKey, groupOfKey, isGroupKey, keyOf, move, settle } from './arrange.js';

/** A project (by id) or a group (by name), for arranging the sidebar. */
export type ArrangeTarget = { readonly project: string } | { readonly group: string };
import { type ProjectScripts, type ResolvedScripts, resolveScripts, saveProjectFile } from './scripts.js';

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
  private refreshGen = 0;
  private appliedGen = 0;

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

  /** Projects that show, alphabetically (the arrangement's starting point). */
  private shownRoots(): string[] {
    return this.projects.filter((p) => p.root).map((p) => p.root);
  }

  private layout(): Layout {
    return { groups: this.config.groups ?? [], ...(this.config.order ? { order: this.config.order } : {}) };
  }

  private saveLayout(layout: Required<Layout>): void {
    this.config = { ...this.config, order: layout.order, groups: layout.groups };
    this.store.saveConfig(this.config);
  }

  /** Projects (Chats first) and groups in the order you arranged them, and the top level's keys. */
  arrangement(): { projects: readonly Project[]; groups: readonly ProjectGroup[]; order: readonly string[] } {
    const repos = this.projects.filter((p) => p.root);
    const { projects, groups, order } = arrangedOrder(this.layout(), repos);
    return { projects: [...this.projects.filter((p) => !p.root), ...projects], groups, order };
  }

  private rootOf(id: string): string {
    const project = this.projects.find((p) => p.id === id && p.root);
    if (!project) throw new WorkspaceError('Project not found');
    return project.root;
  }

  /** A project (by id) or a group, as the arrangement knows it (by root or name). */
  private itemOf(item: ArrangeTarget): Item {
    return 'project' in item ? { project: this.rootOf(item.project) } : { group: item.group };
  }

  /**
   * Move a project into a group or to the top level, or a group among the top level, before
   * another item (or at the end). Unknown projects, groups or places are refused.
   */
  arrange(item: ArrangeTarget, place: { into?: string | null; before?: ArrangeTarget | null } = {}): void {
    try {
      const before = place.before ? this.itemOf(place.before) : null;
      this.saveLayout(move(this.layout(), this.shownRoots(), this.itemOf(item), { into: place.into ?? null, before }, new Set(this.config.hidden)));
    } catch (err) {
      throw err instanceof ArrangeError ? new WorkspaceError(err.message) : err;
    }
  }

  /**
   * A new, empty group (it stays until you delete it), before an item or at the end. With a
   * project, that project moves in, and the group takes its place.
   */
  newGroup(name: string, opts: { before?: ArrangeTarget | null; project?: string } = {}): string {
    const clean = name.trim().slice(0, MAX_GROUP_NAME);
    if (!clean) throw new WorkspaceError('A group needs a name');
    if (this.groups.some((g) => g.name === clean)) throw new WorkspaceError(`There’s already a group called "${clean}"`);
    const roots = this.shownRoots();
    const start = settle(this.layout(), roots, new Set(this.config.hidden));
    const root = opts.project ? this.rootOf(opts.project) : undefined;
    const home = root ? start.groups.find((g) => g.projects.includes(root)) : undefined;
    // Where it goes: before what you said; else where its project is (after that project's group); else last.
    const before = opts.before ? keyOf(this.itemOf(opts.before)) : root && !home ? root : undefined;
    const after = !opts.before && home ? groupKey(home.name) : undefined;
    const at = before !== undefined ? start.order.indexOf(before) : after !== undefined ? start.order.indexOf(after) + 1 : start.order.length;
    if (at < 0) throw new WorkspaceError('It can’t go there');
    const key = groupKey(clean);
    let layout: Required<Layout> = { order: [...start.order.slice(0, at), key, ...start.order.slice(at)], groups: [...start.groups, { name: clean, projects: [] }] };
    if (root) layout = move(layout, roots, { project: root }, { into: clean }, new Set(this.config.hidden));
    this.saveLayout(layout);
    return clean;
  }

  /** Put a project in a group (creating it), or take it out with `group` undefined. */
  setGroup(projectId: string, group: string | undefined): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('Project not found');
    const name = group?.trim().slice(0, MAX_GROUP_NAME);
    const left = (this.config.groups ?? []).find((g) => g.projects.includes(project.root));
    const others = (this.config.groups ?? []).map((g) => ({ ...g, projects: g.projects.filter((r) => r !== project.root) }));
    const groups = name
      ? others.some((g) => g.name === name)
        ? others.map((g) => (g.name === name ? { ...g, projects: [...g.projects, project.root] } : g))
        : [...others, { name, projects: [project.root] }]
      : others;
    // The group it left goes when that leaves it empty (empty groups you made yourself stay).
    const kept = groups.filter((g) => !(g.name === left?.name && g.name !== name && g.projects.length === 0));
    const order = this.config.order ? this.orderAfterSetGroup(this.config.order, project.root, left?.name, name, kept) : undefined;
    this.config = { ...this.config, groups: kept, ...(order ? { order } : {}) };
    this.store.saveConfig(this.config);
  }

  /** Once arranged: a project taken out of its group lands right after it; a group that went, goes. */
  private orderAfterSetGroup(order: readonly string[], root: string, left: string | undefined, into: string | undefined, groups: readonly ProjectGroup[]): string[] {
    const names = new Set(groups.map((g) => g.name));
    const live = (k: string): boolean => k !== root && (!isGroupKey(k) || names.has(groupOfKey(k)));
    if (into) {
      const base = order.filter(live);
      return names.has(into) && !base.includes(groupKey(into)) ? [...base, groupKey(into)] : base;
    }
    // Right after the group it left (in the group's place, if that went).
    const at = left ? order.indexOf(groupKey(left)) : -1;
    if (at < 0) return [...order.filter(live), root];
    return [...order.slice(0, at + 1).filter(live), root, ...order.slice(at + 1).filter(live)];
  }

  /** Rename a group (into another one's name: the two become one). It keeps its place. */
  renameGroup(from: string, to: string): void {
    const name = to.trim().slice(0, MAX_GROUP_NAME);
    const list = this.config.groups ?? [];
    const group = list.find((g) => g.name === from);
    if (!group) throw new WorkspaceError(`No group called "${from}"`);
    if (!name) throw new WorkspaceError('A group needs a name');
    if (name === from) return;
    const into = list.find((g) => g.name === name);
    const groups = into
      ? list.filter((g) => g.name !== from).map((g) => (g.name === name ? { ...g, projects: [...new Set([...g.projects, ...group.projects])] } : g))
      : list.map((g) => (g.name === from ? { ...g, name } : g));
    const order = this.config.order?.flatMap((k) => (k !== groupKey(from) ? [k] : into ? [] : [groupKey(name)]));
    this.config = { ...this.config, groups, ...(order ? { order } : {}) };
    this.store.saveConfig(this.config);
  }

  /** Remove a group: its projects stay, back in the plain project list (where the group was). */
  ungroup(name: string): void {
    const group = (this.config.groups ?? []).find((g) => g.name === name);
    const order = this.config.order?.flatMap((k) => (k === groupKey(name) ? [...(group?.projects ?? [])] : [k]));
    this.config = { ...this.config, groups: (this.config.groups ?? []).filter((g) => g.name !== name), ...(order ? { order } : {}) };
    this.store.saveConfig(this.config);
  }

  /** Projects you hid that are still on disk (their roots), to show again. */
  get hiddenProjects(): readonly string[] {
    const shown = new Set(this.shownRoots());
    return [...new Set(this.config.hidden)].filter((r) => !shown.has(r) && existsSync(r) && isMainCheckout(r)).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  /** Show a hidden project again: it comes back where it was (its group, its place). */
  showProject(root: string): void {
    if (!this.config.hidden.includes(root)) throw new WorkspaceError('That project isn’t hidden');
    this.addProject(root);
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
    const gen = ++this.refreshGen;
    const loaded = await Promise.all(roots.map((root) => this.loadProject(root)));
    // A refresh that started later already finished: its answer is more current than ours.
    if (gen < this.appliedGen) return this.projects;
    this.appliedGen = gen;
    // Same-named projects (e.g. two clones) get their parent folder added so you can tell them apart.
    const counts = new Map<string, number>();
    for (const p of loaded) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const named = loaded
      .map((p) => ((counts.get(p.name) ?? 0) > 1 ? { ...p, name: `${p.name} (${path.basename(path.dirname(p.root))})` } : p))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.projects = [this.chatsProject(new Set(roots)), ...named];
    return this.projects;
  }

  /** Stand-alone Claude chats, always listed first. */
  private chatsProject(roots: ReadonlySet<string> = new Set()): Project {
    const workspaces = this.records
      .filter((r) => r.projectRoot === '')
      // A chat started in a project's main folder is questions only, like any run there.
      .map((r): Workspace => ({ ...r, projectId: CHATS_PROJECT, external: false, ...(roots.has(real(r.path)) ? { askOnly: true } : {}) }))
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
        workspaces.push({ ...record, branch: tree.branch ?? record.branch, base: record.base ?? base, projectId: id, external: !rec && !isMain, ...(isMain ? { askOnly: true } : {}) });
      }
      for (const rec of records) {
        // Chats in the main folder (every project chat, so far) are questions only: work happens in worktrees.
        if (rec.kind === 'chat') workspaces.push({ ...rec, projectId: id, external: false, ...(real(rec.path) === real(root) ? { askOnly: true } : {}) });
        else if (rec.archived && rec.kind === 'worktree') workspaces.push({ ...rec, projectId: id, external: false });
      }
      const withStatus = await Promise.all(
        workspaces.map(async (w) => (w.archived || w.kind === 'chat' ? w : { ...w, status: await g.status(w.path, w.kind === 'main' ? undefined : w.base).catch(() => undefined) })),
      );
      return { id, name, root, base, workspaces: withStatus.sort(order), scripts: resolveScripts(root, this.config.scripts?.[root]) };
    } catch (err) {
      return { id, name, root, base: 'HEAD', workspaces: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------- workspaces

  /**
   * New worktree on a fresh branch from the latest origin default branch, or from `base` (any
   * branch of the project). The worktree remembers what it branched from, so what it's ahead by,
   * its review and its merge compare against that.
   */
  async createWorktree(projectIdOrRoot: string, name: string, base?: string): Promise<Workspace> {
    const project = this.projects.find((p) => p.id === projectIdOrRoot || p.root === projectIdOrRoot);
    if (!project) throw new WorkspaceError('Project not found');
    if (base !== undefined && !(await g.isCommit(project.root, base))) throw new WorkspaceError(`There's no branch called ${base}`);
    const from = base ?? project.base;
    const s = slug(name);
    const dir = this.freeDir(project, s);
    const branch = await this.freeBranch(project.root, `klaud/${s}`);
    await g.addWorktree(project.root, dir, branch, from);
    await g.excludeKlaudDir(dir);
    await copyEnvFiles(project.root, dir);
    const record: WorkspaceRecord = { id: freshId(), projectRoot: project.root, name: s, path: dir, kind: 'worktree', branch, base: from, createdAt: Date.now(), envSnapshot: await envSnapshot(dir) };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** The branches a new worktree can start from, the project's default base first. */
  async branches(projectId: string): Promise<{ base: string; branches: string[] }> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) throw new WorkspaceError('Project not found');
    const all = await g.listBranches(project.root);
    return { base: project.base, branches: [project.base, ...all.filter((b) => b !== project.base)] };
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
    // Runs in the folder you give it (e.g. where you started klaud), or its own scratch folder.
    const dir = inDir ?? path.join(this.chatsDir, id);
    mkdirSync(dir, { recursive: true });
    const record: WorkspaceRecord = { id, projectRoot: '', name: title.trim().slice(0, 40) || 'chat', path: real(dir), kind: 'chat', createdAt: Date.now() };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** Copy a workspace into a new worktree that starts from its current state, with its conversation. */
  async fork(id: string, name: string, opts: { base?: string } = {}): Promise<Workspace> {
    const source = this.require(id);
    const project = this.projectOf(source);
    const s = slug(name);
    const dir = this.freeDir(project, s);
    // `opts.base`: start from there (e.g. the latest origin) instead of the source's own commits.
    const from = opts.base ?? (source.kind === 'chat' ? project.base : (source.branch ?? 'HEAD'));
    const branch = await this.freeBranch(project.root, `klaud/${s}`);
    await g.addWorktree(project.root, dir, branch, from);
    await g.excludeKlaudDir(dir);
    await copyEnvFiles(source.kind === 'chat' ? project.root : source.path, dir);
    const record: WorkspaceRecord = {
      id: freshId(),
      projectRoot: project.root,
      name: s,
      path: dir,
      kind: 'worktree',
      branch,
      base: opts.base ?? source.base ?? project.base,
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
    if (ws.kind === 'main') throw new WorkspaceError("The main folder can't be deleted from klaud");
    if (ws.kind === 'worktree') {
      // Made by another tool (Conductor, Claude Code), even if you've talked in it here: never force-remove it
      // (its uncommitted work isn't ours to discard) and keep its branch.
      const foreign = ws.external || !real(ws.path).startsWith(real(this.store.workspacesDir) + path.sep);
      if (!ws.archived && existsSync(ws.path)) await g.removeWorktree(ws.projectRoot, ws.path, !foreign);
      // Folder deleted by hand: forget it in git too, or the branch stays "checked out" and the worktree comes back.
      else if (!ws.archived) await g.git(ws.projectRoot, ['worktree', 'prune']).catch(() => undefined);
      if (ws.branch && !foreign) await g.deleteBranch(ws.projectRoot, ws.branch).catch(() => undefined);
    }
    rmSync(this.store.historyFile(id), { force: true });
    // Only ever delete klaud's own scratch folders, never a folder you started a chat in.
    if (ws.projectRoot === '' && real(ws.path).startsWith(real(this.chatsDir) + path.sep)) rmSync(ws.path, { recursive: true, force: true });
    this.records = this.records.filter((r) => r.id !== id);
    this.store.saveRecords(this.records);
    await this.refresh();
  }

  /**
   * Remove the worktrees Claude Code sub-agents left behind that have no uncommitted
   * changes. Their branches stay, so nothing committed is lost; anything with
   * uncommitted work is kept.
   */
  async cleanAgentWorktrees(projectId: string): Promise<{ removed: number; kept: number }> {
    const project = this.list.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('That project is gone');
    let removed = 0;
    let kept = 0;
    for (const ws of project.workspaces.filter((w) => !w.archived && worktreeOrigin(w) === 'agent')) {
      if (ws.status?.changed !== 0) {
        kept++;
        continue;
      }
      try {
        await g.removeWorktree(project.root, ws.path, false);
        removed++;
      } catch {
        kept++;
      }
    }
    await this.refresh();
    return { removed, kept };
  }

  /** Pick the model for one workspace's conversation (undefined: your default). */
  setModel(id: string, model: string | undefined): void {
    this.require(id);
    this.patchRecord(id, { model: model || undefined });
  }

  /**
   * Add one run's usage. The SDK reports running totals per conversation, so only the part
   * beyond the last total we saw for the same conversation is new.
   */
  addUsage(id: string, run: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; session?: string }, now = Date.now()): WorkspaceUsage | undefined {
    const ws = this.find(id);
    if (!ws) return undefined;
    const prev = ws.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 };
    const last = prev.last;
    // Same conversation and nothing went down: these are running totals, so only the growth is new.
    const continues = run.session !== undefined && run.session === prev.lastSession && last !== undefined && run.input >= last.input && run.output >= last.output && run.cacheRead >= last.cacheRead && run.cacheWrite >= last.cacheWrite && run.cost >= last.cost;
    const delta = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost'): number => (continues && last ? run[k] - last[k] : run[k]);
    const next: WorkspaceUsage = {
      input: prev.input + delta('input'),
      output: prev.output + delta('output'),
      cacheRead: prev.cacheRead + delta('cacheRead'),
      cacheWrite: prev.cacheWrite + delta('cacheWrite'),
      cost: prev.cost + delta('cost'),
      runs: prev.runs + 1,
      ...(run.session ? { lastSession: run.session, last: { input: run.input, output: run.output, cacheRead: run.cacheRead, cacheWrite: run.cacheWrite, cost: run.cost } } : {}),
      // Per day too, for the Usage screen's chart and "this week".
      days: addDay(prev.days, dayKey(now), { tokens: delta('input') + delta('output') + delta('cacheWrite'), cost: delta('cost') }),
      lastAt: now,
    };
    this.patchRecord(id, { usage: next });
    return next;
  }

  markHandedOff(id: string, to: string): void {
    this.patchRecord(id, { handedTo: to });
  }

  // ---------------------------------------------------------------- scripts

  /** The setup / run commands for a project (yours, then klaud.json, then a guess). */
  scripts(projectId: string): ResolvedScripts {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) return {};
    return resolveScripts(project.root, this.config.scripts?.[project.root]);
  }

  /** Set a project's commands just for you, or in its klaud.json so the whole team gets them. */
  setScripts(projectId: string, scripts: ProjectScripts, opts: { inRepo?: boolean } = {}): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) throw new WorkspaceError('Project not found');
    if (opts.inRepo) {
      saveProjectFile(project.root, scripts);
      return;
    }
    const current = this.config.scripts?.[project.root] ?? {};
    const merged = Object.fromEntries(Object.entries({ ...current, ...scripts }).filter(([, v]) => v)) as ProjectScripts;
    this.config = { ...this.config, scripts: { ...(this.config.scripts ?? {}), [project.root]: merged } };
    this.store.saveConfig(this.config);
  }

  /** Whether you allowed this exact command (from the project's own files) to run by itself. */
  isScriptApproved(projectId: string, command: string): boolean {
    const project = this.projects.find((p) => p.id === projectId);
    return Boolean(project?.root && this.config.approvedScripts?.[project.root]?.includes(commandHash(command)));
  }

  approveScript(projectId: string, command: string): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) return;
    const list = this.config.approvedScripts?.[project.root] ?? [];
    this.config = { ...this.config, approvedScripts: { ...(this.config.approvedScripts ?? {}), [project.root]: [...new Set([...list, commandHash(command)])].slice(-20) } };
    this.store.saveConfig(this.config);
  }

  // ---------------------------------------------------------------- handoff

  /** The project whose origin points at the same repository as `remote` (any URL style). */
  async projectForRemote(remote: string): Promise<Project | undefined> {
    const want = normalizeRemote(remote);
    for (const p of this.projects.filter((x) => x.root)) {
      const url = await g.git(p.root, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => '');
      if (url && normalizeRemote(url) === want) return p;
    }
    return undefined;
  }

  async remoteOf(projectId: string): Promise<string | undefined> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) return undefined;
    return g.git(project.root, ['remote', 'get-url', 'origin']).then((s) => s.trim() || undefined, () => undefined);
  }

  /** A new worktree on an existing branch (e.g. one fetched from a friend's handoff). */
  async createWorktreeOn(projectId: string, name: string, branch: string, extra: Partial<WorkspaceRecord> = {}, opts: { copyEnv?: boolean } = {}): Promise<Workspace> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('Project not found');
    const dir = this.freeDir(project, slug(name));
    await g.git(project.root, ['worktree', 'add', dir, branch]);
    await g.excludeKlaudDir(dir);
    if (opts.copyEnv !== false) await copyEnvFiles(project.root, dir);
    const record: WorkspaceRecord = { id: freshId(), projectRoot: project.root, name: slug(name), path: dir, kind: 'worktree', branch, base: project.base, createdAt: Date.now(), envSnapshot: await envSnapshot(dir), ...extra };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** A free local branch name like klaud/<name>, klaud/<name>-2… */
  freeBranchName(projectRoot: string, name: string): Promise<string> {
    return this.freeBranch(projectRoot, `klaud/${slug(name)}`);
  }

  forgetSession(id: string): void {
    this.patchRecord(id, { sessionId: undefined, forkFromSession: undefined });
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
    return path.join(ws.path, '.klaud');
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

const commandHash = (command: string): string => createHash('sha256').update(command.trim()).digest('hex').slice(0, 16);

/** github.com/kay/api for https://github.com/kay/api.git, git@github.com:kay/api, ssh://git@github.com:22/kay/api… */
export function normalizeRemote(url: string): string {
  const raw = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  const hostPath = scp
    ? `${scp[1]}/${scp[2]}`
    : raw
        .replace(/^[a-z+]+:\/\//i, '')
        .replace(/^[^@/]+@/, '')
        .replace(/^([^/:]+):\d+(?=\/)/, '$1');
  return hostPath.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

function stripLive(ws: Workspace): WorkspaceRecord {
  const { projectId: _p, external: _e, status: _s, askOnly: _a, ...record } = ws;
  return record;
}

const KIND_ORDER = { main: 0, worktree: 1, chat: 2 } as const;
const order = (a: Workspace, b: Workspace): number =>
  Number(a.archived ?? false) - Number(b.archived ?? false) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.createdAt - a.createdAt || a.name.localeCompare(b.name);
