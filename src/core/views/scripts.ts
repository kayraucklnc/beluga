import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CommandSource } from '../../shared/view-spec.js';
import { belugaHome } from '../home.js';

/**
 * A view filled by a script Claude wrote for it (the show tool's `{"kind": "script"}` source):
 * the code is kept in ~/.beluga/view-scripts under a name made from the code itself, and the view
 * runs it as a command source (`python3 '…/3f2a….py' --since {{since}}`). So the view still works
 * in that conversation tomorrow, and the yes it was given covers exactly that code: a script that
 * changes is a new command, and asks again.
 */

const LANGUAGES = {
  sh: { run: '/bin/sh', ext: 'sh' },
  bash: { run: 'bash', ext: 'sh' },
  zsh: { run: 'zsh', ext: 'zsh' },
  python: { run: 'python3', ext: 'py' },
  node: { run: 'node', ext: 'mjs' },
  ruby: { run: 'ruby', ext: 'rb' },
  perl: { run: 'perl', ext: 'pl' },
} as const;
type Language = keyof typeof LANGUAGES;
export const SCRIPT_LANGUAGES = Object.keys(LANGUAGES) as Language[];

const ALIASES: Readonly<Record<string, Language>> = { shell: 'sh', python3: 'python', py: 'python', js: 'node', javascript: 'node', mjs: 'node', rb: 'ruby', pl: 'perl' };
const MAX_CODE = 100_000;

export const viewScriptsDir = (): string => path.join(belugaHome(), 'view-scripts');

/** The language a script asked for, else its #! line's, else sh. */
function languageOf(language: unknown, code: string): Language | undefined {
  const asked = typeof language === 'string' ? language.trim().toLowerCase() : '';
  if (asked) return asked in LANGUAGES ? (asked as Language) : ALIASES[asked];
  const bang = /^#!.*?\b(python3?|node|bash|zsh|sh|ruby|perl)\b/.exec(code)?.[1];
  return bang ? ((bang in LANGUAGES ? bang : ALIASES[bang]) as Language) : 'sh';
}

export interface ScriptPlan {
  readonly code: string;
  readonly file: string;
  /** The command source the view keeps. */
  readonly source: CommandSource & { readonly refresh?: number };
}

/** A `{"kind": "script"}` source as the command it becomes (nothing written yet). Not one: undefined. */
export function planScript(raw: unknown, cwd: string): ScriptPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (s.kind !== 'script' && !(s.kind === undefined && typeof s.script === 'string')) return undefined;
  const code = typeof s.code === 'string' ? s.code : typeof s.script === 'string' ? s.script : '';
  if (!code.trim()) throw new Error('A script source needs its "code"');
  if (code.length > MAX_CODE) throw new Error(`A script may be up to ${MAX_CODE / 1000} KB`);
  const lang = languageOf(s.language ?? s.lang, code);
  if (!lang) throw new Error(`Scripts run as ${SCRIPT_LANGUAGES.join(', ')}`);
  const { run, ext } = LANGUAGES[lang];
  const file = path.join(viewScriptsDir(), `${createHash('sha256').update(`${lang}\u0000${code}`).digest('hex').slice(0, 16)}.${ext}`);
  const args = typeof s.args === 'string' && s.args.trim() ? ` ${s.args.trim()}` : Array.isArray(s.args) ? s.args.map((a) => ` ${String(a)}`).join('') : '';
  const pick = (k: string): Record<string, unknown> => (s[k] !== undefined ? { [k]: s[k] } : {});
  return {
    code,
    file,
    source: {
      kind: 'command',
      command: `${run} '${file.replace(/'/g, `'\\''`)}'${args}`,
      cwd: typeof s.cwd === 'string' && s.cwd ? path.resolve(cwd, s.cwd) : cwd,
      ...pick('format'),
      ...pick('rows'),
      ...pick('timeout'),
      ...pick('refresh'),
    } as ScriptPlan['source'],
  };
}

/** Write the script down (once: its name is its code). */
export function writeScript(plan: ScriptPlan): void {
  if (existsSync(plan.file)) return;
  mkdirSync(path.dirname(plan.file), { recursive: true, mode: 0o700 });
  writeFileSync(plan.file, plan.code, { mode: 0o700 });
}
