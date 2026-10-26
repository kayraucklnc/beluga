import type { Session } from '../core/session.js';
import { detectTerminals } from '../terminal/import/detect.js';
import type { Args, Method } from './api.js';

/** What each `terminalImport.*` method does (see terminal-import-api.ts). Reads only. */

type TerminalImportMethod = Extract<Method, `terminalImport.${string}`>;
type TerminalImportHandlers = { readonly [M in TerminalImportMethod]: (s: Session, ...args: Args<M>) => unknown };

export const TERMINAL_IMPORT_HANDLERS = {
  'terminalImport.detect': () => detectTerminals(),
} satisfies TerminalImportHandlers;
