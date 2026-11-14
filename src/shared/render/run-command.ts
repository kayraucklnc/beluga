import { isTerminal, promptOf, readTerminal } from './terminal.js';

/**
 * What a fenced block would run in a terminal, for its Run button: a shell code block as written
 * (its `$ ` prompts and comment-only lines left out), or a session's commands without what they
 * printed. Undefined when there's nothing to run: code in another language, output, a log.
 * Pure: the screens read alike.
 */

/** Fences that hold shell commands (a script, or a session). */
const SHELL_FENCE = /^(sh|bash|zsh|shell|fish|console|terminal|term|shell-session|sh-session|shellsession|bash-session|zsh-session)$/;

/** A line that's only a comment (zsh, interactive, runs `# note` as a command). */
const COMMENT = /^\s*#/;

export function runnableCommand(lang: string | undefined, code: string): string | undefined {
  const l = (lang ?? '').toLowerCase();
  if (!SHELL_FENCE.test(l)) return undefined;
  const lines = code.split('\n').filter((x) => x.trim() && !COMMENT.test(x));
  if (!lines.length) return undefined;
  // A session (a prompt, then what it printed): only the commands.
  if (isTerminal(l, code)) {
    const commands = readTerminal(code).commands.filter((c) => c.trim() && !COMMENT.test(c));
    return commands.length ? commands.join('\n') : undefined;
  }
  // Commands written with their prompts ("$ npm test"): the prompts come off.
  const prompted = lines.every((x) => promptOf(x) !== undefined);
  const text = (prompted ? lines.map((x) => x.slice(promptOf(x)!.length)) : lines).join('\n').trim();
  return text || undefined;
}

/**
 * The keys that type a command into a shell and run it: Ctrl+U first (whatever was half typed
 * goes), then each line with Return after it.
 */
export function shellInput(command: string): string {
  return `\x15${command.replace(/\r?\n/g, '\r')}\r`;
}
