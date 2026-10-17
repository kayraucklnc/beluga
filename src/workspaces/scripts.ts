import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Commands a project runs in its workspaces: `setup` once per new worktree, `run` on demand. */
export interface ProjectScripts {
  readonly setup?: string;
  readonly run?: string;
}

export type ScriptSource = 'yours' | 'klaude.json' | 'conductor.json' | 'detected';

export interface ResolvedScripts {
  readonly setup?: { readonly command: string; readonly source: ScriptSource };
  readonly run?: { readonly command: string; readonly source: ScriptSource };
  /** Extra pull request instructions for this project (klaude.json "prPrompt"). */
  readonly prPrompt?: string;
}

const Command = z.string().trim().min(1).max(2000);

/** `klaude.json` at the project root, committed so the whole team shares it. */
export const ProjectFile = z.object({
  scripts: z.object({ setup: Command.optional(), run: Command.optional() }).partial().default({}),
  prPrompt: z.string().max(8000).optional(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

const ConductorFile = z.object({ scripts: z.object({ setup: Command.optional(), run: Command.optional() }).partial().default({}) });

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The project's own klaude.json (or Conductor's conductor.json, which uses the same idea). */
export function readProjectFile(root: string): { file?: ProjectFile; conductor?: ProjectScripts } {
  const own = ProjectFile.safeParse(readJson(path.join(root, 'klaude.json')));
  const conductor = ConductorFile.safeParse(readJson(path.join(root, 'conductor.json')));
  return { file: own.success ? own.data : undefined, conductor: conductor.success ? conductor.data.scripts : undefined };
}

const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['yarn.lock', 'yarn install'],
  ['bun.lockb', 'bun install'],
  ['bun.lock', 'bun install'],
  ['package-lock.json', 'npm install'],
  ['uv.lock', 'uv sync'],
  ['poetry.lock', 'poetry install'],
  ['Gemfile.lock', 'bundle install'],
  ['composer.lock', 'composer install'],
];

/** A sensible setup command from the files in the project (e.g. package-lock.json → npm install). */
export function detectSetup(root: string): string | undefined {
  for (const [file, command] of LOCKFILES) if (existsSync(path.join(root, file))) return command;
  if (existsSync(path.join(root, 'package.json'))) return 'npm install';
  if (existsSync(path.join(root, 'requirements.txt'))) return 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt';
  return undefined;
}

/** The usual way to start the project (package.json "dev" or "start"). */
export function detectRun(root: string): string | undefined {
  const pkg = readJson(path.join(root, 'package.json')) as { scripts?: Record<string, unknown> } | undefined;
  const runner = existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock')) ? 'bun' : 'npm';
  for (const name of ['dev', 'start']) {
    if (typeof pkg?.scripts?.[name] === 'string') return runner === 'npm' ? `npm run ${name}` : `${runner} ${name}`;
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) return 'cargo run';
  if (existsSync(path.join(root, 'go.mod'))) return 'go run .';
  return undefined;
}

/**
 * The scripts that apply to a project, in order of preference: what you set in klaude,
 * then klaude.json, then conductor.json, then a guess from its files.
 */
export function resolveScripts(root: string, yours: ProjectScripts = {}): ResolvedScripts {
  const { file, conductor } = readProjectFile(root);
  const pick = (key: keyof ProjectScripts, detect: (r: string) => string | undefined) => {
    if (yours[key]) return { command: yours[key]!, source: 'yours' as const };
    if (file?.scripts[key]) return { command: file.scripts[key]!, source: 'klaude.json' as const };
    if (conductor?.[key]) return { command: conductor[key]!, source: 'conductor.json' as const };
    const guess = detect(root);
    return guess ? { command: guess, source: 'detected' as const } : undefined;
  };
  const setup = pick('setup', detectSetup);
  const run = pick('run', detectRun);
  return { ...(setup ? { setup } : {}), ...(run ? { run } : {}), ...(file?.prPrompt ? { prPrompt: file.prPrompt } : {}) };
}

/** Write the scripts into the project's klaude.json so teammates get them too (keeps other fields). */
export function saveProjectFile(root: string, scripts: ProjectScripts): void {
  const file = path.join(root, 'klaude.json');
  const current = (readJson(file) as Record<string, unknown> | undefined) ?? {};
  const merged = { ...current, scripts: { ...((current.scripts as object | undefined) ?? {}), ...scripts } };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

/** Environment for scripts, matching what Conductor provides so existing scripts work. */
export function scriptEnv(ws: { path: string; name: string; projectRoot: string; branch?: string }): Record<string, string> {
  return {
    KLAUDE_WORKSPACE_PATH: ws.path,
    KLAUDE_WORKSPACE_NAME: ws.name,
    KLAUDE_ROOT_PATH: ws.projectRoot,
    ...(ws.branch ? { KLAUDE_BRANCH: ws.branch } : {}),
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
    CONDUCTOR_ROOT_PATH: ws.projectRoot,
  };
}
