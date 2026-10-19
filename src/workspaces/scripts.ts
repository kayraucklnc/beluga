import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Commands a project runs in its workspaces: `setup` once per new worktree, `run` on demand. */
export interface ProjectScripts {
  readonly setup?: string;
  readonly run?: string;
  /** Yours only: this project needs no setup (learned when nothing fit), so new worktrees skip it. */
  readonly skipSetup?: boolean;
}

export type ScriptSource = 'yours' | 'klaud.json' | 'conductor.json' | 'detected';

export interface ResolvedScripts {
  readonly setup?: { readonly command: string; readonly source: ScriptSource };
  readonly run?: { readonly command: string; readonly source: ScriptSource };
  /** Extra pull request instructions for this project (klaud.json "prPrompt"). */
  readonly prPrompt?: string;
}

const Command = z.string().trim().min(1).max(2000);

/** `klaud.json` at the project root, committed so the whole team shares it. */
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

/** The project's own klaud.json (or Conductor's conductor.json, which uses the same idea). */
export function readProjectFile(root: string): { file?: ProjectFile; conductor?: ProjectScripts } {
  const own = ProjectFile.safeParse(readJson(path.join(root, 'klaud.json')));
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

const JS_LOCKS: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];
/** A plain package-manager install (`yarn`, `npm ci`, `pnpm install --frozen-lockfile`…), nothing chained. */
const JS_INSTALL = /^(npm|yarn|pnpm|bun)(?:\s+(?:install|i|ci)\b[^;&|]*)?$/;

export type SetupCheck = { readonly kind: 'ok' } | { readonly kind: 'skip'; readonly reason: string } | { readonly kind: 'swap'; readonly command: string; readonly reason: string };

/**
 * Does a setup command fit the folder it's about to run in? A JavaScript install in a folder
 * without package.json has nothing to do (skip); one for the wrong package manager (`yarn` where
 * there's only a pnpm-lock.yaml) becomes the right one (swap). Anything else runs as written.
 */
export function checkSetup(dir: string, command: string): SetupCheck {
  const tool = JS_INSTALL.exec(command.trim())?.[1];
  if (!tool) return { kind: 'ok' };
  if (!existsSync(path.join(dir, 'package.json'))) return { kind: 'skip', reason: `there's no package.json, so \`${command.trim()}\` has nothing to install` };
  const owner = JS_LOCKS.find(([file]) => existsSync(path.join(dir, file)))?.[1];
  if (!owner || owner === tool) return { kind: 'ok' };
  const lock = JS_LOCKS.find(([, t]) => t === owner)![0];
  return { kind: 'swap', command: `${owner} install`, reason: `it uses ${owner} (${lock}), not ${tool}` };
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
 * The scripts that apply to a project, in order of preference: what you set in klaud,
 * then klaud.json, then conductor.json, then a guess from its files.
 */
export function resolveScripts(root: string, yours: ProjectScripts = {}): ResolvedScripts {
  const { file, conductor } = readProjectFile(root);
  const pick = (key: 'setup' | 'run', detect: (r: string) => string | undefined) => {
    if (yours[key]) return { command: yours[key]!, source: 'yours' as const };
    if (file?.scripts[key]) return { command: file.scripts[key]!, source: 'klaud.json' as const };
    if (conductor?.[key]) return { command: conductor[key]!, source: 'conductor.json' as const };
    const guess = detect(root);
    return guess ? { command: guess, source: 'detected' as const } : undefined;
  };
  const setup = yours.skipSetup && !yours.setup ? undefined : pick('setup', detectSetup);
  const run = pick('run', detectRun);
  return { ...(setup ? { setup } : {}), ...(run ? { run } : {}), ...(file?.prPrompt ? { prPrompt: file.prPrompt } : {}) };
}

/** Write the scripts into the project's klaud.json so teammates get them too (keeps other fields). */
export function saveProjectFile(root: string, scripts: ProjectScripts): void {
  const file = path.join(root, 'klaud.json');
  const current = (readJson(file) as Record<string, unknown> | undefined) ?? {};
  const merged = { ...current, scripts: { ...((current.scripts as object | undefined) ?? {}), ...scripts } };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

/** Environment for scripts, matching what Conductor provides so existing scripts work. */
export function scriptEnv(ws: { path: string; name: string; projectRoot: string; branch?: string }): Record<string, string> {
  return {
    KLAUD_WORKSPACE_PATH: ws.path,
    KLAUD_WORKSPACE_NAME: ws.name,
    KLAUD_ROOT_PATH: ws.projectRoot,
    ...(ws.branch ? { KLAUD_BRANCH: ws.branch } : {}),
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
    CONDUCTOR_ROOT_PATH: ws.projectRoot,
  };
}
