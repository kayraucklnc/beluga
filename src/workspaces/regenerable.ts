import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * What in a worktree can be thrown away and made again: dependencies (node_modules, .venv,
 * Pods…), build output (dist next to a package.json, target next to a Cargo.toml, Android's
 * build folders…) and caches. Only ever something git ignores, and only where the tool that makes
 * it is there (a `target` folder is Rust's only beside a Cargo.toml): everything else is kept.
 * Pure but for checking which files sit next to a folder.
 */

export interface RegenRule {
  /** What it is, in words ("npm packages"). */
  readonly what: string;
  /** Folder names it covers. */
  readonly names: readonly (string | RegExp)[];
  /** Files beside it that show which tool made it (any one); none: the name says enough. */
  readonly beside?: readonly string[];
  /** How it comes back, when that's something to run ("npm install"). */
  readonly remake?: string;
}

const JS = ['package.json'];
const PY = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'uv.lock', 'poetry.lock'];
const GRADLE = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

export const RULES: readonly RegenRule[] = [
  { what: 'npm packages', names: ['node_modules', 'bower_components'], beside: JS, remake: 'npm install' },
  { what: 'JavaScript build output', names: ['dist', 'build', 'out', '.output', 'storybook-static'], beside: JS, remake: 'npm run build' },
  { what: 'JavaScript build caches', names: ['.next', '.nuxt', '.svelte-kit', '.angular', '.expo', '.vite', '.turbo', '.parcel-cache', '.docusaurus', '.vercel', '.wrangler', '.eslintcache'] },
  { what: 'test coverage', names: ['coverage', '.nyc_output'] },
  { what: 'Rust and Maven build output', names: ['target'], beside: ['Cargo.toml', 'pom.xml'], remake: 'cargo build' },
  { what: 'Gradle and Android build output', names: ['build', '.gradle', '.cxx', '.externalNativeBuild', '.kotlin'], beside: GRADLE, remake: './gradlew build' },
  { what: 'CocoaPods', names: ['Pods'], beside: ['Podfile'], remake: 'pod install' },
  { what: 'Xcode build output', names: ['DerivedData', '.build', '.swiftpm'] },
  { what: 'Python environments', names: ['.venv', 'venv'], beside: PY, remake: 'pip install' },
  { what: 'Python caches', names: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.ipynb_checkpoints', /\.egg-info$/] },
  { what: 'Dart and Flutter build output', names: ['.dart_tool', 'build'], beside: ['pubspec.yaml'], remake: 'flutter pub get' },
  { what: 'PHP packages', names: ['vendor'], beside: ['composer.json'], remake: 'composer install' },
  { what: 'Elixir build output', names: ['_build', 'deps'], beside: ['mix.exs'], remake: 'mix deps.get' },
  { what: 'Haskell build output', names: ['.stack-work', 'dist-newstyle'] },
  { what: 'Zig caches', names: ['.zig-cache', 'zig-cache', 'zig-out'] },
  { what: 'Terraform providers', names: ['.terraform'], remake: 'terraform init' },
  { what: 'caches', names: ['.cache'] },
];

/** Single files that are only ever made by a tool (never anything of yours). */
export const FILE_RULES: readonly RegenRule[] = [
  { what: 'Finder’s folder settings', names: ['.DS_Store'] },
  { what: 'TypeScript build info', names: [/\.tsbuildinfo$/] },
  { what: 'Python caches', names: [/\.py[co]$/] },
];

const nameMatches = (name: string, pattern: string | RegExp): boolean => (typeof pattern === 'string' ? name === pattern : pattern.test(name));

/**
 * The rule that makes this ignored path throwaway (the path relative to the worktree, a folder
 * ending in "/"), else undefined. A file inside such a folder counts too (git lists a folder's
 * files when only some of them are ignored).
 */
export function regenRule(root: string, rel: string): RegenRule | undefined {
  const parts = rel.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    // A file itself is never "a folder made by a tool" (only what's inside one), unless only tools make it.
    if (i === parts.length - 1 && !rel.endsWith('/')) return FILE_RULES.find((r) => r.names.some((n) => nameMatches(name, n)));
    for (const rule of RULES) {
      if (!rule.names.some((n) => nameMatches(name, n))) continue;
      const dir = path.join(root, ...parts.slice(0, i));
      if (rule.beside && !rule.beside.some((b) => existsSync(path.join(dir, b)))) continue;
      return rule;
    }
  }
  return undefined;
}

/** The commands that bring back what was thrown away (each once, in rule order). */
export function remakeSteps(rules: readonly RegenRule[]): string[] {
  return [...new Set(RULES.filter((r) => rules.includes(r) && r.remake).map((r) => r.remake!))];
}
