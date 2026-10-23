/**
 * Klaud became Beluga: this window's own storage (prefs, the onboarding mark, layouts, sorts) was
 * kept under `klaud.*` keys. The first launch of Beluga moves each to its `beluga.*` name, before
 * any module reads one (main.tsx and popup/main.tsx import this first). The web view's storage
 * itself was brought over from Klaud's bundle id by the app shell (src-tauri/src/rename.rs).
 */

const OLD = 'klaud.';
const NEW = 'beluga.';

/** Move every `klaud.*` key to `beluga.*` (a `beluga.*` already there wins). Returns how many moved. */
export function renameStorage(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>): number {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(OLD)) old.push(key);
  }
  let moved = 0;
  for (const key of old) {
    const value = storage.getItem(key);
    const next = NEW + key.slice(OLD.length);
    try {
      if (value !== null && storage.getItem(next) === null) {
        storage.setItem(next, value);
        moved++;
      }
      storage.removeItem(key);
    } catch {
      // Storage full or unavailable: the old key stays, and the next launch tries again.
    }
  }
  return moved;
}

if (typeof localStorage !== 'undefined') {
  try {
    renameStorage(localStorage);
  } catch {
    // No storage in this window (a locked-down web view): there is nothing to move.
  }
}
