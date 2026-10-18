/**
 * TerminalSession: one shell running in a PTY, with its screen state kept by
 * a headless xterm and exposed as klaud `Line[]` snapshots.
 */
import path from 'node:path';
import xtermHeadless, { type IBufferCell, type IDisposable, type Terminal as XTerminal } from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import type { Line } from '../shared/text.js';
import { encodeKey, type InkKeyLike } from './keys.js';
import { buildColorTable } from './palette.js';
import { childEnv, defaultShell, spawnPty, type IPty } from './pty.js';
import { LineRenderer } from './render.js';

// Both packages are CommonJS; Node's ESM loader only exposes `default`.
const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;

export const SCROLLBACK_LINES = 2000;
/** Minimum gap between change notifications (~30fps). */
export const CHANGE_THROTTLE_MS = 33;

export interface TerminalOptions {
  readonly id: string;
  readonly cwd: string;
  /** Program to run. Default: `$SHELL`, else /bin/zsh, else /bin/sh. */
  readonly shell?: string;
  /** Arguments. Default: `['-l']` (login shell; a PTY makes it interactive). */
  readonly args?: readonly string[];
  /** Extra environment, applied over ours (TERM/COLORTERM are set already). */
  readonly env?: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
  /** 16 `#rrggbb` colors for ANSI 0-15. */
  readonly palette?: readonly string[];
  /** Initial title, until the program sets one (OSC 0/2). Default: shell name. */
  readonly title?: string;
}

export interface TerminalExit {
  /** Exit code, or null when killed by a signal / the spawn failed. */
  readonly code: number | null;
  readonly signal?: number;
}

export interface TerminalSnapshot {
  /** One entry per viewport row (`rows` long). Lines are right-trimmed. */
  readonly lines: readonly Line[];
  /** Cursor cell in viewport coordinates; absent when hidden, exited or scrolled off. */
  readonly cursor?: { readonly x: number; readonly y: number };
  readonly title: string;
  readonly exited?: TerminalExit;
  /** How many lines can be scrolled back right now (max useful `scrollBack`). */
  readonly scrollback: number;
  /** The program is on the alternate screen (vim, htop, less...): no scrollback there. */
  readonly altScreen: boolean;
}

const clampSize = (n: number): number => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));

export class TerminalSession {
  readonly id: string;
  readonly cwd: string;
  readonly shell: string;

  private readonly term: XTerminal;
  private readonly renderer: LineRenderer;
  private readonly cell: IBufferCell;
  private readonly listeners = new Set<() => void>();
  private readonly disposables: IDisposable[] = [];
  private pty: IPty | undefined;
  private cols: number;
  private rows: number;
  private titleText: string;
  private exitInfo: TerminalExit | undefined;
  private cursorHidden = false;
  private version = 0;
  private cache: { version: number; back: number; snap: TerminalSnapshot } | undefined;
  private lastNotify = 0;
  private notifyTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(opts: TerminalOptions) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.cols = clampSize(opts.cols);
    this.rows = clampSize(opts.rows);
    this.shell = opts.shell ?? defaultShell();
    this.titleText = opts.title ?? path.basename(this.shell);
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.renderer = new LineRenderer(buildColorTable(opts.palette));
    this.cell = this.term.buffer.active.getNullCell();
    this.watchTerminal();
    this.start(opts);
  }

  get running(): boolean {
    return this.pty !== undefined;
  }

  get title(): string {
    return this.titleText;
  }

  get exited(): TerminalExit | undefined {
    return this.exitInfo;
  }

  /** DECCKM state, for `encodeKey`. */
  get applicationCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  private watchTerminal(): void {
    const parser = this.term.parser;
    // DECTCEM (CSI ? 25 h/l): xterm's public API doesn't expose cursor visibility.
    const trackCursor = (visible: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.cursorHidden = !visible;
      return false; // let xterm handle the mode too
    };
    this.disposables.push(
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackCursor(true)),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackCursor(false)),
      parser.registerEscHandler({ final: 'c' }, () => {
        this.cursorHidden = false; // RIS (full reset)
        return false;
      }),
      this.term.onWriteParsed(() => this.changed()),
      this.term.onTitleChange((t) => {
        this.titleText = t;
        this.changed();
      }),
      // Answers to queries (cursor position, device attributes) go back to the program.
      this.term.onData((d) => this.pty?.write(d)),
    );
  }

  private start(opts: TerminalOptions): void {
    try {
      const pty = spawnPty({
        file: this.shell,
        args: opts.args ?? ['-l'],
        cwd: opts.cwd,
        env: childEnv(opts.env),
        cols: this.cols,
        rows: this.rows,
      });
      this.pty = pty;
      pty.onData((d) => {
        if (!this.disposed) this.term.write(d);
      });
      pty.onExit(({ exitCode, signal }) => {
        this.pty = undefined;
        this.exitInfo = signal ? { code: null, signal } : { code: exitCode };
        this.changed();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.exitInfo = { code: null };
      this.term.write(`\x1b[31mCould not start ${this.shell}: ${message}\x1b[0m\r\n`);
      this.changed();
    }
  }

  /** Raw input bytes (keyboard). Ignored once the program has exited. */
  write(data: string): void {
    if (data) this.pty?.write(data);
  }

  /** Fallback for Ink's parsed keys; see `encodeKey`. */
  writeKey(input: string, key: InkKeyLike): void {
    this.write(encodeKey(input, key, { applicationCursor: this.applicationCursor }));
  }

  /** Paste text, bracketed if the program asked for it (CSI ? 2004 h). */
  paste(text: string): void {
    const body = text.replace(/\r?\n/g, '\r');
    if (!this.term.modes.bracketedPasteMode) return this.write(body);
    // Strip any embedded end marker so pasted text can't break out of the bracket.
    this.write(`\x1b[200~${body.replaceAll('\x1b[201~', '')}\x1b[201~`);
  }

  /** Type a command line and press Enter. */
  run(command: string): void {
    this.write(`${command}\r`);
  }

  resize(cols: number, rows: number): void {
    const c = clampSize(cols);
    const r = clampSize(rows);
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    this.term.resize(c, r);
    try {
      this.pty?.resize(c, r);
    } catch {
      // The process may have exited between the check and the call.
    }
    this.changed();
  }

  /**
   * The viewport, `scrollBack` lines up from the live screen (clamped to the
   * available scrollback). Cached until the screen changes.
   */
  snapshot(scrollBack = 0): TerminalSnapshot {
    const buf = this.term.buffer.active;
    const back = Math.max(0, Math.min(Math.floor(scrollBack) || 0, buf.baseY));
    if (this.cache && this.cache.version === this.version && this.cache.back === back) return this.cache.snap;
    const top = buf.baseY - back;
    const lines: Line[] = [];
    for (let y = 0; y < this.rows; y++) lines.push(this.renderer.render(buf.getLine(top + y), this.cols, this.cell));
    const cy = buf.cursorY + back;
    const showCursor = !this.cursorHidden && !this.exitInfo && cy < this.rows;
    const snap: TerminalSnapshot = {
      lines,
      ...(showCursor ? { cursor: { x: Math.min(buf.cursorX, this.cols - 1), y: cy } } : {}),
      title: this.titleText,
      ...(this.exitInfo ? { exited: this.exitInfo } : {}),
      scrollback: buf.baseY,
      altScreen: buf.type === 'alternate',
    };
    this.cache = { version: this.version, back, snap };
    return snap;
  }

  /** Subscribe to screen changes (throttled to ~30fps). Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.version++;
    if (this.disposed || this.notifyTimer) return;
    const wait = this.lastNotify + CHANGE_THROTTLE_MS - Date.now();
    if (wait <= 0) return this.notify();
    this.notifyTimer = setTimeout(() => this.notify(), wait);
    this.notifyTimer.unref?.();
  }

  private notify(): void {
    this.notifyTimer = undefined;
    this.lastNotify = Date.now();
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A broken listener must not stop the others (or the PTY pump).
      }
    }
  }

  /** Hang up the program (SIGHUP). The screen stays readable. */
  kill(): void {
    try {
      this.pty?.kill();
    } catch {
      // Already gone.
    }
  }

  /** Kill the program and free the emulator. The session is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.kill();
    this.disposed = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.listeners.clear();
    for (const d of this.disposables) d.dispose();
    this.term.dispose();
  }
}
