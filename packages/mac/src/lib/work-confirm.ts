import { closeSheet, currentSheet, openSheet } from './sheets.js';
import type { AskedWork } from './work-asked.js';

export { type AskedWork, asksBeforeWork } from './work-asked.js';

/**
 * Every way in (a toolbar button, the menu bar, a shortcut, the palette, a right-click menu, the
 * Changes panel) asks here before work that starts Claude or changes git.
 */
export function askBeforeWork(wsId: string, action: AskedWork): void {
  const open = currentSheet();
  // Asked again while it's showing (its button pressed twice): it closes.
  if (open?.kind === 'work' && open.wsId === wsId && open.action === action) return closeSheet();
  openSheet({ kind: 'work', wsId, action });
}
