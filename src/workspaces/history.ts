import { git } from './git.js';

/**
 * A repository's history for the Mac app's History view: commits with their parents (for the
 * graph), authors, dates and the refs pointing at them; one commit's files and diff. Reads only.
 */

const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => git(cwd, args).then((s) => s, () => undefined);

export type RefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface CommitRef {
  /** "main", "origin/main", "v1.2", "HEAD". */
  readonly name: string;
  readonly kind: RefKind;
}

export interface CommitInfo {
  readonly hash: string;
  readonly short: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  /** Author date, epoch ms. */
  readonly date: number;
  readonly subject: string;
  readonly body?: string;
  readonly refs: readonly CommitRef[];
  /** On the upstream but not in the checkout yet (what "N behind" means). Only with branch "current". */
  readonly incoming?: boolean;
}

export interface LogOptions {
  /** "all" (every branch and tag), "current" (HEAD, plus its upstream), "default" (the project's main and origin/main), or a branch/tag name. */
  readonly branch?: string;
  /** Part of an author's name or email (case-insensitive, not a pattern). */
  readonly author?: string;
  /** Only commits touching a path: a folder or file ("src/auth"), or part of a file name ("auth"). */
  readonly path?: string;
  /** Where the page starts: the `next` of the page before. */
  readonly before?: string;
  readonly limit?: number;
}

export interface LogPage {
  readonly commits: readonly CommitInfo[];
  /** Pass as `before` for the next page; unset: that was all. */
  readonly next?: string;
}

export const MAX_LOG_PAGE = 300;
const FIELD = '\x1f';
const RECORD = '\x1e';
/** hash, parents, author name, email, date, refs, subject, body. */
const FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%b'].join('%x1f') + '%x1e';

/** Ref decorations ("HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1") as pills. */
export function parseRefs(decoration: string): CommitRef[] {
  const out: CommitRef[] = [];
  for (const raw of decoration.split(',').map((r) => r.trim()).filter(Boolean)) {
    const head = /^HEAD -> (.+)$/.exec(raw);
    if (head) out.push({ name: 'HEAD', kind: 'head' });
    const ref = head ? head[1]! : raw;
    if (ref === 'HEAD') out.push({ name: 'HEAD', kind: 'head' });
    else if (ref.startsWith('tag: ')) out.push({ name: ref.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' });
    else if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), kind: 'branch' });
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      if (!name.endsWith('/HEAD')) out.push({ name, kind: 'remote' });
    } else if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice('refs/tags/'.length), kind: 'tag' });
  }
  return out;
}

/** `git log` output in FORMAT → commits. */
export function parseLog(out: string): CommitInfo[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [hash = '', parents = '', name = '', email = '', at = '0', refs = '', subject = '', body = ''] = r.split(FIELD);
      const text = body.trim();
      return {
        hash,
        short: hash.slice(0, 7),
        parents: parents.split(' ').filter(Boolean),
        author: { name, email },
        date: Number(at) * 1000,
        subject,
        ...(text ? { body: text } : {}),
        refs: parseRefs(refs),
      };
    });
}

/** A path search as pathspecs: "src/auth" is a path, a bare word matches file and folder names containing it. */
export function pathspecs(search: string): string[] {
  const term = search.trim().replace(/^\.\/+/, '');
  if (!term) return [];
  if (term.includes('/') || term.includes('.')) return [`:(icase)${term}`, `:(glob,icase)**/*${escapeGlob(term)}*`, `:(glob,icase)**/*${escapeGlob(term)}*/**`];
  return [`:(glob,icase)**/*${escapeGlob(term)}*`, `:(glob,icase)**/*${escapeGlob(term)}*/**`];
}

const escapeGlob = (s: string): string => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);

/** Whether `ref` can be read as a revision (never as an option). */
const safeRef = (ref: string): boolean => Boolean(ref) && !ref.startsWith('-') && !/[\s~^:?*[\\]|\.\./.test(ref);

/** The project's default branch and what it tracks, for branch "default" (main and origin/main). */
export interface DefaultRefs {
  readonly branch: string;
  readonly upstream?: string;
}

/** The revisions for a branch choice. */
async function revisions(dir: string, branch: string, defaults?: DefaultRefs): Promise<string[]> {
  // Branches, remote branches, tags and HEAD (not the stash, notes or a forge's pull refs).
  if (branch === 'all') return ['--branches', '--remotes', '--tags', 'HEAD'];
  if (branch === 'default' && defaults) {
    const local = await tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${defaults.branch}`]);
    const revs = [...(local ? [`refs/heads/${defaults.branch}`] : []), ...(defaults.upstream ? [defaults.upstream] : [])];
    if (revs.length) return revs;
  }
  if (branch === 'current' || branch === 'default') {
    const upstream = (await tryGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))?.trim();
    return upstream ? ['HEAD', upstream] : ['HEAD'];
  }
  if (!safeRef(branch)) throw new Error(`There’s no branch called ${branch}`);
  const ok = await tryGit(dir, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (!ok) throw new Error(`There’s no branch called ${branch}`);
  return [branch];
}

/** Commits on the upstream not in the branch yet (for "incoming" rows), capped. */
async function incomingSet(dir: string, range: string): Promise<Set<string>> {
  const out = await tryGit(dir, ['rev-list', '--max-count=1000', range]);
  return new Set((out ?? '').split('\n').filter(Boolean));
}

/** A page of history, newest first, children always before their parents (for the graph). */
export async function log(dir: string, opts: LogOptions = {}, defaults?: DefaultRefs): Promise<LogPage> {
  const limit = Math.max(1, Math.min(MAX_LOG_PAGE, Math.floor(opts.limit ?? 100)));
  const skip = Math.max(0, Number.parseInt(opts.before ?? '0', 10) || 0);
  const branch = opts.branch || 'all';
  const revs = await revisions(dir, branch, defaults);
  const author = opts.author?.trim();
  const paths = pathspecs(opts.path ?? '');
  const args = [
    'log',
    '--date-order',
    '--decorate=full',
    `--format=${FORMAT}`,
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    ...(author ? ['--fixed-strings', '--regexp-ignore-case', `--author=${author}`] : []),
    // Path-limited history keeps the graph connected through the commits it skips.
    ...(paths.length ? ['--parents'] : []),
    ...revs,
    '--',
    ...paths,
  ];
  const out = await tryGit(dir, args);
  // An empty repository (no commits yet) has no history rather than an error.
  if (out === undefined) {
    const anyCommit = await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!anyCommit && branch !== 'all') return { commits: [] };
    if (!anyCommit) return { commits: [] };
    throw new Error('Couldn’t read the history');
  }
  const all = parseLog(out);
  const page = all.slice(0, limit);
  const range = branch === 'current' ? 'HEAD..@{upstream}' : branch === 'default' && defaults?.upstream ? `refs/heads/${defaults.branch}..${defaults.upstream}` : undefined;
  const incoming = range ? await incomingSet(dir, range) : undefined;
  const commits = incoming?.size ? page.map((c) => (incoming.has(c.hash) ? { ...c, incoming: true } : c)) : page;
  return { commits, ...(all.length > limit ? { next: String(skip + limit) } : {}) };
}

export interface CommitFile {
  readonly path: string;
  /** Where a renamed file came from. */
  readonly from?: string;
  readonly added: number;
  readonly removed: number;
  readonly state: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly binary?: boolean;
  /** This file's part of the diff (unset: too big to show, or binary). */
  readonly diff?: string;
}

export interface CommitDetail {
  readonly commit: CommitInfo;
  readonly files: readonly CommitFile[];
  /** Compared with this (the first parent; the empty tree for the first commit). */
  readonly against?: string;
  /** Some diffs were left out (a huge commit). */
  readonly truncated?: boolean;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_BYTES = 1_500_000;
const MAX_FILE_DIFF_BYTES = 200_000;
const MAX_FILES = 500;

/** `git diff` output split per file, keyed by the file's (new) path. */
export function splitDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const part of parts) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part)?.[1];
    const renamed = /^rename to (.+)$/m.exec(part)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const file = renamed ?? (plus && plus !== '/dev/null' ? plus : header?.[2] ?? header?.[1]);
    if (file) out.set(file.replace(/^"|"$/g, ''), part);
  }
  return out;
}

/** `--numstat -z` and `--name-status -z` output → files (renames keep where they came from). */
export function parseNumstat(numstat: string, nameStatus: string): CommitFile[] {
  const states = new Map<string, { state: CommitFile['state']; from?: string }>();
  const ns = nameStatus.split('\0').filter((x) => x !== '');
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++] ?? '';
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = ns[i++] ?? '';
      const to = ns[i++] ?? '';
      states.set(to, code.startsWith('R') ? { state: 'renamed', from } : { state: 'added' });
    } else {
      const file = ns[i++] ?? '';
      states.set(file, { state: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified' });
    }
  }
  const files: CommitFile[] = [];
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; ) {
    const line = parts[i++] ?? '';
    if (!line) continue;
    const [a = '0', r = '0', inline = ''] = line.split('\t');
    // A rename: "added\tremoved\t" then the old and new paths as their own entries.
    const file = inline || ((i += 2), parts[i - 1] ?? '');
    const binary = a === '-' && r === '-';
    const st = states.get(file) ?? { state: 'modified' as const };
    files.push({ path: file, ...(st.from ? { from: st.from } : {}), added: binary ? 0 : Number(a) || 0, removed: binary ? 0 : Number(r) || 0, state: st.state, ...(binary ? { binary: true } : {}) });
  }
  return files;
}

const isHash = (h: string): boolean => /^[0-9a-f]{4,64}$/i.test(h);

/** One commit: its message, files with +/− and each file's diff (against its first parent). */
export async function commitDetail(dir: string, hash: string): Promise<CommitDetail> {
  if (!isHash(hash)) throw new Error('That isn’t a commit hash');
  const head = await tryGit(dir, ['log', '-1', '--decorate=full', `--format=${FORMAT}`, hash, '--']);
  const commit = head ? parseLog(head)[0] : undefined;
  if (!commit) throw new Error(`There’s no commit ${hash.slice(0, 12)} here`);
  const against = commit.parents[0] ?? EMPTY_TREE;
  const range = [against, commit.hash];
  const [numstat, nameStatus] = await Promise.all([git(dir, ['diff', '-M', '--numstat', '-z', ...range]), git(dir, ['diff', '-M', '--name-status', '-z', ...range])]);
  const listed = parseNumstat(numstat, nameStatus);
  const files = listed.slice(0, MAX_FILES);
  const patch = (await tryGit(dir, ['diff', '-M', '--no-color', '--no-ext-diff', ...range])) ?? '';
  const byFile = splitDiff(patch.length > MAX_DIFF_BYTES * 2 ? '' : patch);
  let budget = MAX_DIFF_BYTES;
  let truncated = listed.length > MAX_FILES || (patch.length > 0 && byFile.size === 0);
  const withDiffs = files.map((f) => {
    const diff = byFile.get(f.path);
    if (!diff || f.binary) return f;
    if (diff.length > MAX_FILE_DIFF_BYTES || diff.length > budget) {
      truncated = true;
      return f;
    }
    budget -= diff.length;
    return { ...f, diff };
  });
  return { commit, files: withDiffs, ...(commit.parents[0] ? { against: commit.parents[0] } : {}), ...(truncated ? { truncated: true } : {}) };
}

export interface HistoryFilters {
  /** What the checkout is on ("main"; unset: a detached HEAD). */
  readonly current?: string;
  /** Local branches, most recent first. */
  readonly branches: readonly string[];
  /** Remote-tracking branches ("origin/main"), most recent first. */
  readonly remotes: readonly string[];
  readonly tags: readonly string[];
  /** People who committed recently, the most active first. */
  readonly authors: ReadonlyArray<{ readonly name: string; readonly email: string; readonly commits: number }>;
}

/** The choices for History's filters: branches, tags and recent authors. */
export async function historyFilters(dir: string): Promise<HistoryFilters> {
  const [cur, refs, recent] = await Promise.all([
    tryGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    tryGit(dir, ['for-each-ref', '--sort=-committerdate', '--count=400', '--format=%(refname)%09%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    tryGit(dir, ['log', '--branches', '--remotes', '--tags', 'HEAD', '--max-count=3000', '--format=%an%x1f%ae']),
  ]);
  const branches: string[] = [];
  const remotes: string[] = [];
  const tags: string[] = [];
  for (const [ref = '', symref] of (refs ?? '').split('\n').map((l) => l.split('\t'))) {
    if (!ref || symref) continue;
    if (ref.startsWith('refs/heads/')) branches.push(ref.slice(11));
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remotes.push(ref.slice(13));
    else if (ref.startsWith('refs/tags/')) tags.push(ref.slice(10));
  }
  const people = new Map<string, { name: string; email: string; commits: number }>();
  for (const line of (recent ?? '').split('\n').filter(Boolean)) {
    const [name = '', email = ''] = line.split(FIELD);
    const key = email.toLowerCase() || name;
    const p = people.get(key);
    people.set(key, p ? { ...p, commits: p.commits + 1 } : { name, email, commits: 1 });
  }
  const current = cur?.trim();
  return {
    ...(current ? { current } : {}),
    branches,
    remotes,
    tags: tags.slice(0, 100),
    authors: [...people.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name)).slice(0, 200),
  };
}
