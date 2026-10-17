import { PassThrough } from 'node:stream';

export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | 'move';

export interface MouseEvent {
  /** 0-based column */
  readonly x: number;
  /** 0-based row */
  readonly y: number;
  readonly button: MouseButton;
  readonly kind: 'press' | 'release';
}

// SGR extended mouse reports: ESC [ < button ; col ; row (M = press, m = release)
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// 1003 = report pointer movement too (for hover feedback), 1006 = SGR coordinates.
export const MOUSE_ON = '\x1b[?1000h\x1b[?1003h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1003l\x1b[?1000l\x1b[?1006l';

function buttonOf(code: number): MouseButton | undefined {
  if (code & 64) return code & 1 ? 'wheelDown' : 'wheelUp';
  if (code & 32) return 'move';
  switch (code & 3) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return undefined;
  }
}

/** Pull mouse reports out of a stdin chunk, returning the events and the remaining keyboard input. */
export function parseMouse(chunk: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  const rest = chunk.replace(SGR, (_m, b: string, col: string, row: string, kind: string) => {
    const button = buttonOf(Number(b));
    if (button) events.push({ x: Number(col) - 1, y: Number(row) - 1, button, kind: kind === 'M' ? 'press' : 'release' });
    return '';
  });
  return { events, rest };
}

// Focus reports (after FOCUS_ON): the terminal window came to the front, or went to the back.
const FOCUS = /\x1b\[([IO])/g;
export const FOCUS_ON = '\x1b[?1004h';
export const FOCUS_OFF = '\x1b[?1004l';

/** Pull focus reports out of a chunk: true = focused, false = in the background. */
export function parseFocus(chunk: string): { events: boolean[]; rest: string } {
  const events: boolean[] = [];
  const rest = chunk.replace(FOCUS, (_m, c: string) => {
    events.push(c === 'I');
    return '';
  });
  return { events, rest };
}

export interface InputHooks {
  readonly onMouse?: (e: MouseEvent) => void;
  readonly onFocus?: (focused: boolean) => void;
  /**
   * While this returns a function, keyboard input goes straight to it instead of Ink
   * (the built-in terminal has the keyboard). Mouse and focus reports are still handled.
   */
  readonly rawSink?: () => ((data: string) => void) | undefined;
}

/**
 * A stdin stand-in for Ink: forwards keyboard input untouched but removes mouse
 * reports (so they never show up as typed text) and hands them to `onMouse`.
 */
export function createMouseInput(source: NodeJS.ReadStream, onMouse: (e: MouseEvent) => void): NodeJS.ReadStream {
  return createInput(source, { onMouse });
}

/** Like createMouseInput, plus focus reports and handing keys to the built-in terminal. */
export function createInput(source: NodeJS.ReadStream, hooks: InputHooks): NodeJS.ReadStream {
  const proxy = new PassThrough({ encoding: 'utf8' }) as unknown as NodeJS.ReadStream & { isTTY: boolean };
  Object.assign(proxy, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      source.setRawMode?.(mode);
      return proxy;
    },
    ref: () => {
      source.ref?.();
      return proxy;
    },
    unref: () => {
      source.unref?.();
      return proxy;
    },
  });
  source.setEncoding('utf8');
  source.on('data', (data: string | Buffer) => {
    const { events, rest: afterMouse } = parseMouse(data.toString());
    for (const e of events) hooks.onMouse?.(e);
    const { events: focus, rest } = parseFocus(afterMouse);
    for (const f of focus) hooks.onFocus?.(f);
    if (!rest) return;
    const sink = hooks.rawSink?.();
    if (sink) sink(rest);
    else proxy.write(rest);
  });
  return proxy;
}
