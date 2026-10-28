import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from './home.js';

/**
 * Needs-you items you dismissed without answering (BLG-359), by id: they leave the phone's list,
 * the Mac's "Waiting for you" and its notifications, and stay gone across restarts. An id the
 * Mac no longer has waiting is dropped the next time you dismiss something, so the file stays small.
 */

const KEEP = 300;

export const dismissedNeedsPath = (): string => path.join(belugaHome(), 'dismissed-needs.json');

export function loadDismissedNeeds(file: string = dismissedNeedsPath()): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length <= 300).slice(-KEEP) : [];
  } catch {
    return [];
  }
}

/** The list after dismissing `id`: what's still waiting (`live`) and was dismissed, plus `id`. */
export function withDismissed(was: readonly string[], id: string, live: ReadonlySet<string>): string[] {
  return [...was.filter((d) => d !== id && live.has(d)), id].slice(-KEEP);
}

export function saveDismissedNeeds(ids: readonly string[], file: string = dismissedNeedsPath()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(ids)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Not saved: it's still dismissed until Beluga restarts.
  }
}
