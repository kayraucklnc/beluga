import type { CcOutput } from '../../../../src/core/claude-code/model.js';

/**
 * A sub-agent's Outputs, as plain data: where each file is (said from the nearest place you
 * know) and how it came to be. No DOM (tests/mac-agent-outputs.test.ts).
 */

export interface Places {
  /** Its own scratch folder. */
  readonly scratch?: string;
  /** Where its session runs. */
  readonly cwd?: string;
  readonly home?: string;
}

/** macOS's per-user temp folder (what $TMPDIR is). */
const MAC_TMP = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T(?=\/|$)/;

const under = (root: string | undefined, p: string): string | undefined => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : undefined);

/** A file's name, and its folder from its own scratch folder, the project, your home, else in full. */
export function placeOf(p: string, places: Places): { name: string; dir: string } {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const parent = p.slice(0, p.length - name.length - 1);
  const inScratch = under(places.scratch, `${parent}/`);
  if (inScratch !== undefined || parent === places.scratch) return { name, dir: (inScratch ?? '').replace(/\/$/, '') };
  const inCwd = under(places.cwd, p);
  if (inCwd !== undefined) return { name, dir: inCwd.slice(0, -name.length - 1) };
  const inHome = under(places.home, p);
  if (inHome !== undefined) return { name, dir: `~/${inHome.slice(0, -name.length - 1)}`.replace(/\/$/, '') };
  if (MAC_TMP.test(parent)) return { name, dir: parent.replace(MAC_TMP, 'tmp') };
  return { name, dir: parent || '/' };
}

export const howLabel = (how: CcOutput['how']): string => (how === 'wrote' ? 'Saved' : how === 'ran' ? 'From a command' : 'Looked at');

/** Changes only when a file does (a new one, rewritten, or gone). */
export const outputsKey = (list: ReadonlyArray<Pick<CcOutput, 'path' | 'mtime' | 'size'>>): string => list.map((o) => `${o.path}:${o.mtime}:${o.size}`).join('|');
