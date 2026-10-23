import chalk from 'chalk';

const SPIN = ['◐', '◓', '◑', '◒'];
const FRAME_MS = 80;

export const ink = {
  claude: chalk.hex('#d4876c'),
  ok: chalk.hex('#9cbf8f'),
  warn: chalk.hex('#d8b878'),
  error: chalk.hex('#d08585'),
  info: chalk.hex('#8fb3cf'),
  muted: chalk.hex('#7d8590'),
  text: chalk.hex('#d6d9de'),
};

export interface Out {
  readonly write: (s: string) => void;
  readonly tty: boolean;
}

export const stdout: Out = { write: (s) => process.stdout.write(s), tty: Boolean(process.stdout.isTTY) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seconds(ms: number): string {
  return ms < 1000 ? '' : ink.muted(` ${(ms / 1000).toFixed(1)}s`);
}

/** The Beluga prompt mark, typed out one letter at a time with a blinking coral cursor. */
export async function title(out: Out, subtitle: string): Promise<void> {
  const word = 'beluga';
  if (!out.tty) {
    out.write(`\n  ❯ ${word}  ${subtitle}\n\n`);
    return;
  }
  out.write('\n');
  for (let i = 0; i <= word.length; i++) {
    out.write(`\r  ${ink.muted('❯')} ${chalk.bold(ink.text(word.slice(0, i)))}${ink.claude('▌')}`);
    await sleep(35);
  }
  out.write(`\r  ${ink.muted('❯')} ${chalk.bold(ink.text(word))} ${ink.claude('▌')} ${ink.muted(subtitle)}\n\n`);
}

/** Start of line, cleared (only on a real terminal). */
const clear = (out: Out) => (out.tty ? '\r\x1b[K' : '');

/** Run `task` while a spinner animates on its line; then tick it off (or cross it out). */
export async function step<T>(out: Out, label: string, task: () => Promise<T>, done?: (v: T) => string): Promise<T> {
  const started = Date.now();
  let frame = 0;
  const draw = () => out.write(`\r  ${ink.claude(SPIN[frame++ % SPIN.length])} ${ink.text(label)}${ink.muted('…')}\x1b[K`);
  const timer = out.tty ? setInterval(draw, FRAME_MS) : undefined;
  if (out.tty) draw();
  try {
    const value = await task();
    out.write(`${clear(out)}  ${ink.ok('✓')} ${ink.text(done ? done(value) : label)}${seconds(Date.now() - started)}\n`);
    return value;
  } catch (err) {
    out.write(`${clear(out)}  ${ink.error('✗')} ${ink.text(label)}\n`);
    throw err;
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** A short fill animation for the finish line. */
export async function bar(out: Out, label: string, width = 28): Promise<void> {
  if (!out.tty) return;
  for (let i = 0; i <= width; i++) {
    out.write(`\r  ${ink.claude('━'.repeat(i))}${ink.muted('─'.repeat(width - i))} ${ink.muted(label)}\x1b[K`);
    await sleep(14);
  }
  out.write('\r\x1b[K');
}

export function line(out: Out, s = ''): void {
  out.write(`${s ? `  ${s}` : ''}\n`);
}
