import { z } from 'zod';

/**
 * Bringing your terminal's look into Beluga (BLG-212): which other terminals are on this Mac
 * (Ghostty, iTerm2, Terminal, Alacritty, kitty, WezTerm, Warp) and what their colours, font and
 * cursor come to. Read-only: the Mac app applies what you pick to its own terminal settings.
 * Browser-safe: zod only.
 */

export const TERMINAL_IMPORT_API = {
  // The terminals here, installed or with settings to read, and each one's look → TerminalFound[].
  'terminalImport.detect': { args: z.tuple([]) },
} as const;
