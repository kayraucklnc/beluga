// Whether one path is a folder's or inside it, for Mac, Linux and Windows paths alike. Browser-safe.

/** A folder's path ends here: "/" anywhere, and "\" too on Windows. */
const SEP = /[\\/]/;

/**
 * `p` is `root` or inside it: `root` followed by a "/" or "\" (never a look-alike sibling,
 * /code/app-old for /code/app). Windows paths (a drive letter or \\server) match without regard to
 * letter case, as Windows does.
 */
export function isUnder(root: string, p: string): boolean {
  if (!root) return false;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  const r = windows ? root.toLowerCase() : root;
  const q = windows ? p.toLowerCase() : p;
  if (q === r) return true;
  if (!q.startsWith(r)) return false;
  return SEP.test(r.at(-1) ?? '') || SEP.test(q[r.length] ?? '');
}

/** `p` from inside `root`, without the separator ("src/a.ts"), or undefined when it isn't inside. */
export function underPart(root: string, p: string): string | undefined {
  if (!isUnder(root, p) || p.length === root.length) return undefined;
  return p.slice(root.length).replace(/^[\\/]/, '');
}
