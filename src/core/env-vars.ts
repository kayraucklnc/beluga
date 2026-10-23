/**
 * Environment variables you set for your shells, setup and run commands, and your Claude:
 * your own (everywhere) and per project (over yours). They're kept in ~/.beluga/env.json,
 * readable only by you, and never leave this computer: screens get their names, and the
 * values only when one asks (Settings), never in the shared state or anything sent to the room.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ENV_KEY, type EnvKeys, type EnvVar, MAX_ENV_VALUE, MAX_ENV_VARS, envProblems, envRecord, mergeEnv, parseEnvText } from '../shared/env-vars.js';
import type { Project } from '../workspaces/types.js';
import { belugaHome } from './home.js';
import type { Store } from './store.js';

const Vars = z.record(z.string().regex(ENV_KEY), z.string().max(MAX_ENV_VALUE));

/** What env.json holds. */
export const EnvFile = z.object({
  global: Vars.default({}),
  /** By project folder. `dotenv`: also load the project's .env file. */
  projects: z.record(z.string(), z.object({ vars: Vars.default({}), dotenv: z.boolean().default(false) })).default({}),
});
export type EnvFile = z.infer<typeof EnvFile>;

const EMPTY: EnvFile = { global: {}, projects: {} };
/** A .env bigger than this isn't read. */
const MAX_DOTENV_BYTES = 256 * 1024;

export const envPath = (): string => path.join(belugaHome(), 'env.json');

export function loadEnvFile(file: string = envPath()): EnvFile {
  try {
    const parsed = EnvFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Save atomically, readable only by you. */
export function saveEnvFile(data: EnvFile, file: string = envPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The variables in a folder's .env (none when there's no file, or it's too big). */
export function readDotenv(dir: string): Record<string, string> {
  const file = path.join(dir, '.env');
  try {
    if (statSync(file).size > MAX_DOTENV_BYTES) return {};
    return envRecord(parseEnvText(readFileSync(file, 'utf8')).vars);
  } catch {
    return {};
  }
}

/** One place's variables, for the Settings editor. */
export interface EnvScope {
  readonly vars: readonly EnvVar[];
  /** Also load the project's .env (projects only). */
  readonly dotenv: boolean;
  /** Names in the project's .env right now (shown so you know what it adds). */
  readonly dotenvKeys: readonly string[];
}

/** Where something runs: a workspace, a project, or just a folder. */
export interface EnvPlace {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly dir?: string;
}

export interface EnvVarsDeps {
  readonly store: Store;
  readonly file?: string;
}

const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export class EnvVars {
  private data: EnvFile;

  constructor(private readonly deps: EnvVarsDeps) {
    this.data = loadEnvFile(deps.file);
    this.publish();
  }

  private get projects(): readonly Project[] {
    return this.deps.store.getState().projects.filter((p) => p.root);
  }

  private project(id: string | undefined): Project | undefined {
    return id ? this.projects.find((p) => p.id === id) : undefined;
  }

  /** Tell screens the names (never the values). */
  private publish(): void {
    const projects = Object.fromEntries(Object.entries(this.data.projects).map(([root, p]) => [root, { keys: Object.keys(p.vars), dotenv: p.dotenv }]));
    const keys: EnvKeys = { global: Object.keys(this.data.global), projects };
    this.deps.store.dispatch({ type: 'env_keys', keys });
  }

  /** Your variables (no project), or a project's. */
  get(projectId?: string): EnvScope {
    if (!projectId) return { vars: toRows(this.data.global), dotenv: false, dotenvKeys: [] };
    const project = this.project(projectId);
    const saved = project ? this.data.projects[project.root] : undefined;
    return { vars: toRows(saved?.vars ?? {}), dotenv: saved?.dotenv ?? false, dotenvKeys: project ? Object.keys(readDotenv(project.root)) : [] };
  }

  /**
   * Replace your variables (no project) or a project's, and whether it loads its .env.
   * Rows without a name are skipped; a bad name or one used twice refuses the whole change.
   */
  set(projectId: string | undefined, rows: readonly EnvVar[], dotenv?: boolean): void {
    const filled = rows.filter((r) => r.key || r.value);
    const problem = [...envProblems(filled).values()][0];
    if (problem) throw new Error(problem);
    if (filled.length > MAX_ENV_VARS) throw new Error(`Up to ${MAX_ENV_VARS} variables`);
    const vars = envRecord(filled);
    if (!projectId) {
      this.data = { ...this.data, global: vars };
    } else {
      const project = this.project(projectId);
      if (!project) throw new Error('That project is gone');
      const before = this.data.projects[project.root];
      const next = { vars, dotenv: dotenv ?? before?.dotenv ?? false };
      const { [project.root]: _old, ...others } = this.data.projects;
      this.data = { ...this.data, projects: Object.keys(vars).length || next.dotenv ? { ...others, [project.root]: next } : others };
    }
    saveEnvFile(this.data, this.deps.file);
    this.publish();
  }

  /** Set (or with an empty value, remove) one of your variables, or one of a project's. */
  setOne(projectId: string | undefined, key: string, value: string | undefined): void {
    const rows = this.get(projectId).vars.filter((r) => r.key !== key);
    this.set(projectId, value === undefined ? rows : [...rows, { key, value }]);
  }

  /** The project something runs in: the workspace's, the one named, or the one whose folder holds `dir`. */
  private placeOf(where: EnvPlace): { project?: Project; dir?: string } {
    const projects = this.projects;
    if (where.workspaceId) {
      for (const p of projects) {
        const ws = p.workspaces.find((w) => w.id === where.workspaceId);
        if (ws) return { project: p, dir: ws.path };
      }
    }
    const named = this.project(where.projectId);
    if (named) return { project: named, dir: where.dir ?? named.root };
    const dir = where.dir ? path.resolve(where.dir) : undefined;
    if (!dir) return {};
    const project = projects.find((p) => inside(dir, p.root) || p.workspaces.some((w) => inside(dir, w.path)));
    return { project, dir };
  }

  /**
   * The variables for something starting there: yours, then the project's .env (when you
   * switched that on; the workspace's own copy first), then the project's own variables.
   */
  envFor(where: EnvPlace = {}): Record<string, string> {
    const { project, dir } = this.placeOf(where);
    const own = project ? this.data.projects[project.root] : undefined;
    const dotenv = own?.dotenv && project ? { ...readDotenv(project.root), ...(dir && dir !== project.root ? readDotenv(dir) : {}) } : undefined;
    return mergeEnv(this.data.global, dotenv, own?.vars);
  }
}

const toRows = (vars: Readonly<Record<string, string>>): EnvVar[] => Object.entries(vars).map(([key, value]) => ({ key, value }));
