import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Small helpers for the network's files under ~/.beluga: everything is written readable only
 * by you (0600), whole files atomically (temp file, then rename), logs a line at a time.
 */

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Every line of a JSON-lines file that parses (a torn last line after a crash is skipped). */
export function readLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export function appendLine(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Rewrite a JSON-lines file in one go (used to compact or drop entries). */
export function writeLines(file: string, values: readonly unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, values.map((v) => `${JSON.stringify(v)}\n`).join(''), { mode: 0o600 });
  renameSync(tmp, file);
}

/** JSON with keys in a fixed order, so the same value always hashes and signs the same. */
export function canonical(value: unknown, depth = 0): string {
  // Nothing Beluga writes nests this deep; refusing it keeps hostile input from blowing the stack.
  if (depth > 32) throw new Error('Too deeply nested');
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(',')}}`;
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** A file name safe for an id we didn't make ourselves. */
export const safeName = (id: string): string => id.replace(/[^\w-]/g, '_').slice(0, 80);
