// Shells for the built-in terminal, as data: their friendly names and how to start them. Browser-safe.

/** A shell installed on this computer. */
export interface ShellChoice {
  readonly path: string;
  /** "zsh", "bash", "fish", "Nushell"… */
  readonly name: string;
  /** Your login shell ($SHELL): what Beluga uses when you haven't picked one. */
  readonly isDefault: boolean;
}

const NAMES: Readonly<Record<string, string>> = {
  zsh: 'zsh',
  bash: 'bash',
  sh: 'sh',
  dash: 'dash',
  ksh: 'ksh',
  mksh: 'mksh',
  tcsh: 'tcsh',
  csh: 'csh',
  fish: 'fish',
  nu: 'Nushell',
  elvish: 'Elvish',
  xonsh: 'xonsh',
  pwsh: 'PowerShell',
  'pwsh-preview': 'PowerShell Preview',
  oil: 'Oils',
  osh: 'Oils (osh)',
  ysh: 'Oils (ysh)',
};

const base = (file: string): string => file.split(/[\\/]/).pop() ?? file;

/** "fish" for /opt/homebrew/bin/fish; unknown shells keep their file name. */
export const shellName = (file: string): string => NAMES[base(file)] ?? base(file);

/** Shells that understand POSIX sh syntax (`a && b`, `$(…)`), so scripts written for sh run in them. */
export const isPosixShell = (file: string): boolean => ['zsh', 'bash', 'sh', 'dash', 'ksh', 'mksh', 'osh'].includes(base(file));

/** Arguments for an interactive shell: `-l` when it's a login shell, then your own. */
export const shellArgs = (opts: { readonly login: boolean; readonly extra: readonly string[] }): string[] => [...(opts.login ? ['-l'] : []), ...opts.extra];

/**
 * Split typed arguments the way a shell would: spaces separate them, quotes keep spaces in one.
 * `--rcfile "my rc"` → ['--rcfile', 'my rc'].
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let any = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (current || any) out.push(current);
      current = '';
      any = false;
    } else current += ch;
  }
  if (current || any) out.push(current);
  return out;
}

/** Arguments back into text for editing (quoted where they hold spaces). */
export const joinArgs = (args: readonly string[]): string => args.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, "'")}"` : a)).join(' ');
