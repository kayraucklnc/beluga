import { redactSecrets } from '../../shared/steps.js';

/**
 * Background commands in a Claude Code transcript: a shell command started with
 * `run_in_background` (a dev server, the full tests, a build) or a watch (Monitor). Claude Code
 * writes each one's output to a file (tasks/<id>.output) and reports back when it ends
 * (`<task-notification>`). Pure: watch.ts reads the files.
 */

/** command: a background shell command · monitor: a watch that reports each event. */
export type TaskKind = 'command' | 'monitor';

export interface BgLaunch {
  readonly toolUseId: string;
  readonly kind: TaskKind;
  /** What it's for, in words ("Start the dev server"), else the command's start. */
  readonly description: string;
  /** The command (secrets redacted, bounded). */
  readonly command: string;
  readonly ts: number;
}

const COMMAND_MAX = 2000;
const WORDS_MAX = 80;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** A tool call that starts a background command or a watch → what it is (undefined: anything else). */
export function bgLaunchOf(toolUseId: string, name: string, input: Readonly<Record<string, unknown>>, ts: number): BgLaunch | undefined {
  const kind: TaskKind | undefined = name === 'Monitor' ? 'monitor' : name === 'Bash' && input.run_in_background === true ? 'command' : undefined;
  if (!kind) return undefined;
  const command = redactSecrets(typeof input.command === 'string' ? input.command : '');
  const said = typeof input.description === 'string' ? oneLine(redactSecrets(input.description)) : '';
  return { toolUseId, kind, description: clip(said || oneLine(command) || 'Background command', WORDS_MAX), command: clip(command, COMMAND_MAX), ts };
}

const ID = /^[\w-]{1,64}$/;
const ID_IN_TEXT = /(?:in background with ID:|started \(task)\s*([\w-]{1,64})/;
const OUTPUT_IN_TEXT = /Output is being written to: (\S+?\.output)(?=[.\s]|$)/;

/** The task id Claude Code gave a background command or watch (from its result). */
export function taskIdOf(toolUseResult: unknown, text: string): string | undefined {
  const r = (toolUseResult ?? {}) as { backgroundTaskId?: unknown; taskId?: unknown };
  for (const v of [r.backgroundTaskId, r.taskId]) if (typeof v === 'string' && ID.test(v)) return v;
  return ID_IN_TEXT.exec(text)?.[1];
}

/** Where its output goes, as its result says. */
export const outputFileOf = (text: string): string | undefined => OUTPUT_IN_TEXT.exec(text)?.[1];

/** "… failed with exit code 2", "… completed (exit code 0)" → the exit code. */
export function exitCodeOf(summary: string | undefined): number | undefined {
  const m = summary ? /exit code (\d{1,3})/.exec(summary) : null;
  return m ? Number(m[1]) : undefined;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Terminal output as text: colours and cursor codes out, a line redrawn with \r shows as it ended. */
export function cleanTerminal(text: string): string {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r+$/, '').split('\r');
      return parts[parts.length - 1] ?? '';
    })
    .join('\n');
}
