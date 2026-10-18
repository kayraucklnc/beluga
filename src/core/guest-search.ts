import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type ShareConfig, isDenied, resolveInShare } from './shares.js';

export interface SearchHit {
  readonly path: string;
  readonly line?: number;
  readonly text?: string;
}

export interface SearchLimits {
  readonly maxHits: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly timeMs: number;
}

export const SEARCH_LIMITS: SearchLimits = { maxHits: 200, maxFiles: 5000, maxFileBytes: 256 * 1024, timeMs: 3000 };

/**
 * `find <name>` / `grep <text>` for someone browsing one of your shared folders. Runs on
 * your computer but stays inside the share, never follows links out of it, skips secrets,
 * .git and node_modules, and stops early (files scanned, hits, time) so it can't run away.
 */
export async function searchShare(share: ShareConfig, start: string, mode: 'find' | 'grep', query: string, limits: SearchLimits = SEARCH_LIMITS): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const base = start.replace(/^\/+|\/+$/g, '');
  const startDir = resolveInShare(share, base);
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  const deadline = Date.now() + limits.timeMs;
  let files = 0;
  let truncated = false;
  const queue: Array<{ abs: string; rel: string }> = [{ abs: startDir, rel: base }];
  while (queue.length) {
    const dir = queue.shift() as { abs: string; rel: string };
    const entries = await fs.readdir(dir.abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (hits.length >= limits.maxHits || files >= limits.maxFiles || Date.now() > deadline) return { hits, truncated: true };
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      // Links are skipped: they could point anywhere.
      if (isDenied(rel) || e.isSymbolicLink()) continue;
      const abs = path.join(dir.abs, e.name);
      if (e.isDirectory()) {
        if (mode === 'find' && e.name.toLowerCase().includes(needle)) hits.push({ path: rel });
        queue.push({ abs, rel });
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      if (mode === 'find') {
        if (e.name.toLowerCase().includes(needle)) hits.push({ path: rel });
        continue;
      }
      const found = await grepFile(abs, needle, limits.maxFileBytes);
      for (const h of found) {
        if (hits.length >= limits.maxHits) {
          truncated = true;
          break;
        }
        hits.push({ path: rel, ...h });
      }
    }
  }
  return { hits, truncated };
}

async function grepFile(abs: string, needle: string, maxBytes: number): Promise<Array<{ line: number; text: string }>> {
  const handle = await fs.open(abs, 'r').catch(() => undefined);
  if (!handle) return [];
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.includes(0)) return [];
    const out: Array<{ line: number; text: string }> = [];
    data
      .toString('utf8')
      .split('\n')
      .forEach((l, i) => {
        if (out.length < 20 && l.toLowerCase().includes(needle)) out.push({ line: i + 1, text: l.trim().slice(0, 200) });
      });
    return out;
  } finally {
    await handle.close();
  }
}
