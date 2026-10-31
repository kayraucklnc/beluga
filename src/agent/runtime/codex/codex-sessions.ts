import { open, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../claude/claude-sessions.js';

/**
 * Forgetting Codex's own record of a conversation (BLG-532). Codex writes each one to
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl (archived ones to
 * archived_sessions/), its first line a session_meta with the thread id and the folder it ran in.
 */

/** Where Codex keeps its data (CODEX_HOME, else ~/.codex). */
export const codexDataDir = (): string => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

const HEAD = 64 * 1024;

/** A rollout's thread id and folder, from its session_meta line. */
async function metaOf(file: string): Promise<{ id?: string; cwd?: string }> {
  const fh = await open(file, 'r').catch(() => undefined);
  if (!fh) return {};
  try {
    const buf = Buffer.alloc(HEAD);
    const { bytesRead } = await fh.read(buf, 0, HEAD, 0);
    const first = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
    const d = JSON.parse(first) as { type?: string; payload?: { id?: unknown; cwd?: unknown } };
    if (d.type !== 'session_meta') return {};
    return { ...(typeof d.payload?.id === 'string' ? { id: d.payload.id } : {}), ...(typeof d.payload?.cwd === 'string' ? { cwd: d.payload.cwd } : {}) };
  } catch {
    return {};
  } finally {
    await fh.close();
  }
}

/** Every rollout file under a folder of Codex's, at any depth. */
async function rollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await rollouts(p)));
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Delete Codex's rollouts for one thread (a deleted chat's), or for every thread that ran in a
 * folder being deleted for good. Nothing else of Codex's is touched.
 */
export async function dropCodexSessions(which: { readonly threadId?: string; readonly dir?: string }, home: string = codexDataDir()): Promise<number> {
  const { threadId, dir } = which;
  if (!threadId && !dir) return 0;
  if (threadId && !/^[\w-]{1,100}$/.test(threadId)) return 0;
  let dropped = 0;
  for (const top of ['sessions', 'archived_sessions']) {
    for (const file of await rollouts(path.join(home, top))) {
      // The file name ends in the thread id: only those are opened when looking for one.
      if (threadId && !dir && !file.endsWith(`-${threadId}.jsonl`)) continue;
      const meta = await metaOf(file);
      const match = threadId ? meta.id === threadId : !!meta.cwd && samePath(meta.cwd, dir!);
      if (!match) continue;
      await rm(file, { force: true }).catch(() => undefined);
      dropped++;
    }
  }
  return dropped;
}
