import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder Beluga runs from (dist/core/version.js → the package root). */
export function installRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Beluga's version, from its package.json (the Mac app's daemon carries its build: 0.6.2+mac.0.11.0). */
export function installedVersion(root = installRoot()): string {
  try {
    return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
