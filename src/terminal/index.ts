/**
 * Embedded terminal engine: a PTY-backed shell whose screen (kept by a
 * headless xterm) is exposed as klaud `Line[]` snapshots.
 *
 *   const term = manager.open('ws-1', { cwd, cols, rows });
 *   const off = term.onChange(() => rerender());
 *   const { lines, cursor } = term.snapshot(scrollOffset);
 *   term.write(rawStdinBytes);
 */
export { TerminalSession, SCROLLBACK_LINES, CHANGE_THROTTLE_MS } from './session.js';
export type { TerminalOptions, TerminalSnapshot, TerminalExit } from './session.js';
export { TerminalManager, type OpenOptions } from './manager.js';
export { encodeKey, isLeaveChord, isLeaveKey, type InkKeyLike, type EncodeOptions } from './keys.js';
export { overlayCursor } from './render.js';
export { DEFAULT_PALETTE, buildColorTable } from './palette.js';
export { defaultShell, childEnv } from './pty.js';
