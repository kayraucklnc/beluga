import { PassThrough } from 'node:stream';

export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | 'move';

export interface MouseEvent {
  /** 0-based column */
  readonly x: number;
  /** 0-based row */
  readonly y: number;
  readonly button: MouseButton;
  readonly kind: 'press' | 'release';
  /** Modifier keys held (SGR reports carry them: 4 = Shift, 8 = Option/Alt/Meta, 16 = Ctrl). */
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly ctrl?: boolean;
}

/** The modifier keys held in an SGR button code (only the ones that are down). */
export function modifiersOf(code: number): { shift?: true; alt?: true; ctrl?: true } {
  return { ...(code & 4 ? { shift: true as const } : {}), ...(code & 8 ? { alt: true as const } : {}), ...(code & 16 ? { ctrl: true as const } : {}) };
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

// A report whose ESC was already eaten (e.g. it arrived in an earlier chunk): never let it show up as typed text.
const ORPHAN = /\[<\d+;\d+;\d+[Mm]/g;

/** Pull mouse reports out of a stdin chunk, returning the events and the remaining keyboard input. */
export function parseMouse(chunk: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  const rest = chunk.replace(SGR, (_m, b: string, col: string, row: string, kind: string) => {
    const code = Number(b);
    const button = buttonOf(code);
    if (button) events.push({ x: Number(col) - 1, y: Number(row) - 1, button, kind: kind === 'M' ? 'press' : 'release', ...modifiersOf(code) });
    return '';
  });
  return { events, rest: rest.replace(ORPHAN, '') };
}

// The start of an escape sequence cut off at the end of a chunk (fast scrolling splits reports across reads).
const PARTIAL = /\x1b(?:\[(?:<[\d;]*)?)?$/;
/** How long to wait for the rest of a cut-off sequence before treating it as typed (a lone Esc key). */
export const PARTIAL_WAIT_MS = 25;

/**
 * Joins stdin chunks so escape sequences split across reads are parsed whole.
 * `push` returns the text that's safe to parse now; a cut-off tail is held until
 * the next chunk, or handed to `onFlush` if nothing follows (a real Esc press).
 */
export function createChunkJoiner(onFlush: (data: string) => void, waitMs = PARTIAL_WAIT_MS): (chunk: string) => string {
  let held = '';
  let timer: NodeJS.Timeout | undefined;
  return (chunk) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const data = held + chunk;
    const tail = PARTIAL.exec(data);
    held = tail ? tail[0] : '';
    if (held) {
      timer = setTimeout(() => {
        const pending = held;
        held = '';
        timer = undefined;
        onFlush(pending);
      }, waitMs);
    }
    return tail ? data.slice(0, tail.index) : data;
  };
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

// Bracketed paste: pasted text arrives between these markers, so an empty paste can be seen too.
export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
const PASTE = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;

/**
 * Offer each complete paste in a chunk to `take`; pastes it takes are removed, the rest stay
 * as they were (Ink reads the markers itself). `plain` drops the markers instead (raw keyboard).
 */
export function takePastes(chunk: string, take: (text: string) => boolean, plain = false): string {
  if (!chunk.includes('\x1b[200~')) return chunk;
  return chunk.replace(PASTE, (whole, text: string) => (take(text) ? '' : plain ? text : whole));
}

export interface InputHooks {
  readonly onMouse?: (e: MouseEvent) => void;
  readonly onFocus?: (focused: boolean) => void;
  /**
   * While this returns a function, keyboard input goes straight to it instead of Ink
   * (the built-in terminal has the keyboard). Mouse and focus reports are still handled.
   */
  readonly rawSink?: () => ((data: string) => void) | undefined;
  /** A paste arrived (maybe empty: an image on the clipboard); return true to swallow it. */
  readonly onPaste?: (text: string) => boolean;
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
  const deliver = (text: string): void => {
    const { events, rest: afterMouse } = parseMouse(text);
    for (const e of events) hooks.onMouse?.(e);
    const { events: focus, rest } = parseFocus(afterMouse);
    for (const f of focus) hooks.onFocus?.(f);
    if (!rest) return;
    const sink = hooks.rawSink?.();
    const keys = takePastes(rest, (t) => (sink ? false : (hooks.onPaste?.(t) ?? false)), Boolean(sink));
    if (!keys) return;
    if (sink) sink(keys);
    else proxy.write(keys);
  };
  const join = createChunkJoiner(deliver);
  source.on('data', (data: string | Buffer) => {
    const text = join(data.toString());
    if (text) deliver(text);
  });
  return proxy;
}
