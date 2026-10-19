/**
 * Shell commands that only look: what Claude may run in a project's main folder, where nothing
 * may change (work happens in worktrees). Deliberately conservative: anything not clearly
 * read-only (redirects into files, command substitution, unknown programs, flags that write or
 * run other programs) counts as a change. Browser-safe: no Node imports.
 */

/** Programs that never write, with flags that would make them write or run something else. */
const PROGRAMS: Readonly<Record<string, readonly string[]>> = {
  ls: [],
  cat: [],
  head: [],
  tail: [],
  wc: [],
  pwd: [],
  echo: [],
  printf: [],
  true: [],
  file: [],
  stat: [],
  du: [],
  df: [],
  which: [],
  type: [],
  tree: ['-o'],
  grep: [],
  egrep: [],
  fgrep: [],
  rg: ['--pre'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sort: ['-o', '--output'],
  cut: [],
  tr: [],
  nl: [],
  column: [],
  jq: [],
  diff: [],
  basename: [],
  dirname: [],
  realpath: [],
  readlink: [],
  date: [],
  cd: [],
};

/** git subcommands that only read (some only in a listing form, checked below). */
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote',
  'cat-file', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'count-objects', 'check-ignore', 'whatchanged', 'version', 'help',
  'branch', 'tag', 'remote', 'config', 'stash', 'worktree', 'reflog',
]);

/** Flags that make `git branch` list rather than create, rename or delete. */
const BRANCH_LIST = /^(-a|-r|-l|-v|-vv|--all|--remotes|--list|--verbose|--show-current|--no-color|--color(=.*)?|--sort=.*|--format=.*|--contains|--no-contains|--merged|--no-merged|--points-at|--column|--no-column|--abbrev=.*)$/;

/** Split a command line into its simple commands (on |, ||, &&, ;, & and newlines), keeping quotes intact. */
export function segments(command: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      if (ch === '\\' && quote === '"') {
        cur += ch + (command[++i] ?? '');
        continue;
      }
      cur += ch;
      continue;
    }
    // Outside quotes a backslash makes the next character plain (\' is not a quote, \; not a separator).
    if (ch === '\\') {
      cur += ch + (command[++i] ?? '');
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote) return undefined;
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The words of one simple command (quotes removed). */
export function words(segment: string): string[] {
  return (segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []).map((w) => w.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1'));
}

/** Output redirection that only goes to the terminal or nowhere (2>&1, >/dev/null). */
export const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null/g;

function gitReads(args: readonly string[]): boolean {
  let i = 0;
  // Global options before the subcommand: only the harmless ones.
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!;
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks') i++;
    else if (a === '-C') i += 2;
    else return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || !GIT_READ.has(sub)) return false;
  // --output writes a file; grep -O opens a pager program.
  if (rest.some((a) => a.startsWith('--output') || a === '-O' || a.startsWith('--open-files-in-pager'))) return false;
  const positional = rest.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'branch':
      // Listing, optionally with a pattern after --list / -l.
      return rest.every((a) => !a.startsWith('-') || BRANCH_LIST.test(a)) && (positional.length === 0 || rest.includes('--list') || rest.includes('-l'));
    case 'tag':
      return rest.length === 0 || rest.includes('-l') || rest.includes('--list');
    case 'remote':
      return rest.length === 0 || rest.every((a) => a === '-v' || a === '--verbose') || rest[0] === 'show' || rest[0] === 'get-url';
    case 'config':
      return rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a)) && !rest.some((a) => ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit'].includes(a));
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree':
      return rest[0] === 'list';
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' || rest[0]!.startsWith('-');
    default:
      return true;
  }
}

function npmReads(args: readonly string[]): boolean {
  return ['ls', 'list', 'view', 'info', 'outdated', 'why', 'explain', '--version', '-v'].includes(args[0] ?? '');
}

/**
 * Environment settings a read-only command may lead with (they only change how it prints). Others
 * can run programs (GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND, PATH…), and a bare `PATH=…` would last
 * for the commands after it.
 */
const SAFE_ENV = /^(GIT_PAGER|PAGER|LESS|LANG|LC_ALL|LC_CTYPE|TERM|NO_COLOR|COLUMNS|TZ)=[\w.:/=-]*$/;

function simpleReads(segment: string): boolean {
  const all = words(segment);
  const start = all.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  // A bare assignment changes the shell for what follows: not a read.
  if (start < 0) return false;
  if (!all.slice(0, start).every((w) => SAFE_ENV.test(w))) return false;
  const [program, ...args] = all.slice(start);
  if (!program) return true;
  if (program === 'git') return gitReads(args);
  if (program === 'npm' || program === 'pnpm' || program === 'yarn') return npmReads(args);
  if (program === 'node' || program === 'python3' || program === 'python') return args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V');
  const banned = PROGRAMS[program];
  if (!banned) return false;
  return !args.some((a) => banned.some((b) => a === b || a.startsWith(`${b}=`)));
}

/** True when running `command` can't change anything (files, git, processes). */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  // Command and process substitution run commands we can't see; here-docs and redirects write.
  if (/\$\(|`|<\(|>\(|<</.test(text)) return false;
  if (text.replace(HARMLESS_REDIRECT, '').includes('>')) return false;
  const parts = segments(text.replace(HARMLESS_REDIRECT, ''));
  if (!parts?.length) return false;
  return parts.every(simpleReads);
}
