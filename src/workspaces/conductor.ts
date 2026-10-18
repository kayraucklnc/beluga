import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What Conductor (the Mac app that runs coding agents in parallel worktrees) knows about a
 * worktree it made: its name, whether it's archived, its PR title and the Claude Code
 * conversation it has open. Strictly read-only: the database is opened immutable, through
 * the system's sqlite3, and nothing is ever written there.
 */

export interface ConductorWorkspace {
  readonly path: string;
  /** The name you gave it in Conductor, else its folder ("berlin"). */
  readonly name: string;
  readonly state?: string;
  readonly branch?: string;
  readonly prTitle?: string;
  /** The Claude Code session Conductor has open in it. */
  readonly sessionId?: string;
  readonly sessionTitle?: string;
  readonly updatedAt?: string;
}

/** Where Conductor makes worktrees by default: ~/conductor/workspaces/<repo>/<city>. */
export const conductorRoot = (home = os.homedir()): string => path.join(home, 'conductor', 'workspaces');

export const conductorDb = (home = os.homedir()): string => path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');

/** Whether a folder is in Conductor's workspaces folder. */
export function inConductorRoot(dir: string, home = os.homedir()): boolean {
  const root = conductorRoot(home);
  return dir.startsWith(root + path.sep) || /\/conductor\/workspaces\/[^/]+\/[^/]+/.test(dir);
}

const QUERY = `SELECT w.workspace_path AS path, w.directory_name AS dir, w.workspace_name AS name, w.state AS state, w.branch AS branch,
  w.pr_title AS prTitle, w.updated_at AS updatedAt, s.claude_session_id AS sessionId, s.title AS sessionTitle
  FROM workspaces w LEFT JOIN sessions s ON s.id = w.active_session_id WHERE w.workspace_path IS NOT NULL`;

type Row = { path?: string; dir?: string; name?: string; state?: string; branch?: string; prTitle?: string; updatedAt?: string; sessionId?: string; sessionTitle?: string };

const nonEmpty = (v: string | undefined | null): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Parse sqlite3's -json output into workspaces; the live one wins over archived ones at the same path. */
export function parseConductorRows(json: string): ConductorWorkspace[] {
  let rows: Row[];
  try {
    rows = JSON.parse(json || '[]') as Row[];
  } catch {
    return [];
  }
  const byPath = new Map<string, ConductorWorkspace>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = nonEmpty(r.path);
    if (!p) continue;
    const ws: ConductorWorkspace = {
      path: p,
      name: nonEmpty(r.name) ?? nonEmpty(r.dir) ?? path.basename(p),
      ...(nonEmpty(r.state) ? { state: nonEmpty(r.state) } : {}),
      ...(nonEmpty(r.branch) ? { branch: nonEmpty(r.branch) } : {}),
      ...(nonEmpty(r.prTitle) ? { prTitle: nonEmpty(r.prTitle) } : {}),
      ...(nonEmpty(r.sessionId) ? { sessionId: nonEmpty(r.sessionId) } : {}),
      ...(nonEmpty(r.sessionTitle) && r.sessionTitle !== 'Untitled' ? { sessionTitle: nonEmpty(r.sessionTitle) } : {}),
      ...(nonEmpty(r.updatedAt) ? { updatedAt: nonEmpty(r.updatedAt) } : {}),
    };
    const prev = byPath.get(p);
    const live = (w: ConductorWorkspace): boolean => w.state !== 'archived';
    if (!prev || (live(ws) && !live(prev)) || (live(ws) === live(prev) && (ws.updatedAt ?? '') > (prev.updatedAt ?? ''))) byPath.set(p, ws);
  }
  return [...byPath.values()];
}

const CACHE_MS = 30_000;
let cached: { db: string; at: number; list: ConductorWorkspace[] } | undefined;

/** Every workspace Conductor knows (empty when Conductor isn't installed or can't be read). */
export function readConductorWorkspaces(db = conductorDb()): Promise<ConductorWorkspace[]> {
  if (cached && cached.db === db && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.list);
  if (!existsSync(db)) return Promise.resolve([]);
  // immutable=1: sqlite never writes, locks or touches the WAL; mode=ro on top, to be sure.
  const uri = `file:${encodeURI(db).replace(/\?/g, '%3f').replace(/#/g, '%23')}?mode=ro&immutable=1`;
  return new Promise((resolve) => {
    execFile('sqlite3', ['-readonly', '-json', uri, QUERY], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const list = err ? [] : parseConductorRows(stdout);
      cached = { db, at: Date.now(), list };
      resolve(list);
    });
  });
}
