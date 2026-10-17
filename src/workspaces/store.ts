import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectsConfig, WorkspaceRecord } from './types.js';

export { klaudHome } from '../core/home.js';
import { klaudHome } from '../core/home.js';

export const DEFAULT_ROOTS = ['Projects', 'projects', 'code', 'Code', 'dev', 'src', 'Developer', 'GitHub', 'repos', 'workspace'].map((d) => path.join(os.homedir(), d));

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Small JSON-file persistence for projects, workspaces and per-workspace chat history. */
export class WorkspaceStore {
  constructor(private readonly home: string = klaudHome()) {}

  get workspacesDir(): string {
    return path.join(this.home, 'workspaces');
  }

  loadConfig(): ProjectsConfig {
    const raw = readJson<Partial<ProjectsConfig>>(path.join(this.home, 'projects.json'), {});
    return { roots: raw.roots ?? DEFAULT_ROOTS, projects: raw.projects ?? [], hidden: raw.hidden ?? [], groups: raw.groups ?? [] };
  }

  saveConfig(config: ProjectsConfig): void {
    writeJson(path.join(this.home, 'projects.json'), config);
  }

  loadRecords(): WorkspaceRecord[] {
    return readJson<{ workspaces?: WorkspaceRecord[] }>(path.join(this.home, 'workspaces.json'), {}).workspaces ?? [];
  }

  saveRecords(records: readonly WorkspaceRecord[]): void {
    writeJson(path.join(this.home, 'workspaces.json'), { workspaces: records });
  }

  historyFile(id: string): string {
    return path.join(this.home, 'history', `${id.replace(/[^\w.-]/g, '_')}.json`);
  }

  loadHistory<T>(id: string): T[] {
    return readJson<T[]>(this.historyFile(id), []);
  }

  saveHistory(id: string, items: readonly unknown[]): void {
    writeJson(this.historyFile(id), items);
  }
}
