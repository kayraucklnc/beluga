import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Location, ViewerState } from '@klaud/core/store.js';
import type { FsEntry } from '@klaud/protocol.js';
import { shareNameOf } from '@klaud/shared/share-names.js';
import { formatBytes } from '@klaud/shared/format.js';
import { Markdown } from '../../chat/Markdown.js';
import { Icon } from '../../components/Icon.js';
import { ActionsContext, type ActionItem } from '../../components/SpecMenu.js';
import { Empty, IconButton, Segmented, cx } from '../../components/ui.js';
import { useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { localPathOf, revealInFinder } from '../../lib/files.js';
import { focusFor, openFocus } from '../../lib/panel.js';
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampShare } from '../../lib/panel-model.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import { mod } from '../../lib/system.js';
import { STATE } from '../../views/DiffView.js';
import { Bitmap, LANG, ext, fenced, useRowItems } from '../../views/FilesView.js';
import d from '../../views/diff.module.css';
import f from '../../views/files.module.css';
import { ResizeHandle } from './ResizeHandle.js';
import { type TreeRow, ancestorsOf, filterLoads, treeRows } from './tree.js';
import s from './panel.module.css';

/** Folders you opened in each workspace's tree, kept while the window is open. */
const opened = new Map<string, ReadonlySet<string>>();

/** Files that run something when opened (double-click shows them in Finder instead). */
const RUNS = /\.(command|tool|app|pkg|mpkg|terminal|workflow|scpt|scptd|action|sh|zsh|bash|py|rb|pl|jar)$/i;

/** Open a file of yours the way Finder would (its default app, usually your editor). */
async function openWithDefaultApp(client: ReturnType<typeof useKlaud>['client'], path: string): Promise<void> {
  if (RUNS.test(path)) return revealInFinder(client, path);
  await client.api.local.openFolder(path);
}

/** A name with the part you typed highlighted. */
function Marked({ name, query }: { name: string; query: string }): ReactNode {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark className={s.mark}>{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  );
}

/** The open file, as the Files view shows it (Markdown formatted, code in color, images as they are). */
function Preview({ viewer, wsId, local }: { viewer: ViewerState; wsId: string; local: string | undefined }) {
  const api = useApi();
  const { client } = useKlaud();
  const [raw, setRaw] = useState(false);
  const name = viewer.path.split('/').pop() || viewer.path;
  const dir = viewer.path.slice(0, viewer.path.length - name.length).replace(/\/$/, '');
  const markdown = ext(viewer.path) === 'md' || ext(viewer.path) === 'markdown';
  return (
    <section className={s.preview} aria-label={name}>
      <div className={s.previewHead}>
        <Icon name="file" size={13} className={s.fileIcon} />
        <span className={s.previewName} title={viewer.path}>
          {name}
        </span>
        {dir ? <span className={s.previewDir}>{dir}</span> : null}
        <span className={s.flex} />
        {markdown ? (
          <Segmented
            label="Show as"
            value={raw ? 'raw' : 'rendered'}
            onChange={(v) => setRaw(v === 'raw')}
            options={[
              { value: 'rendered', label: 'Preview' },
              { value: 'raw', label: 'Source' },
            ]}
          />
        ) : null}
        {local ? <IconButton icon="external" label="Open with its app" onClick={() => void openWithDefaultApp(client, local)} /> : null}
        <IconButton icon="expand" label="Open in full" keys={`${mod()}↩`} onClick={() => openFocus('file', wsId)} />
        <IconButton icon="x" label="Close" keys="Esc" onClick={() => void api.files.closeViewer()} />
      </div>
      <div className={cx(s.previewBody, 'selectable')}>
        {viewer.loading && !viewer.content && !viewer.image ? (
          <div className={s.dimPad}>Opening…</div>
        ) : viewer.error ? (
          <Empty icon="alert" title="Can’t open this file" detail={viewer.error} />
        ) : viewer.image ? (
          <div className={f.imageWrap}>
            <Bitmap image={viewer.image} />
          </div>
        ) : markdown && !raw ? (
          <div className={s.doc}>
            <Markdown text={viewer.content} />
          </div>
        ) : (
          <div className={cx(f.codeWrap, s.code)}>
            <Markdown text={fenced(viewer.content, LANG[ext(viewer.path)])} />
          </div>
        )}
        {viewer.truncated ? <div className={f.truncated}>Only the beginning is shown.</div> : null}
      </div>
    </section>
  );
}

/**
 * The right panel's Files: the workspace's folder as a tree (filter it by name), and the file you
 * pick, previewed under it. Double-click opens a file in its app; right-click for the rest.
 */
export function FilesTab({ wsId }: { wsId: string }) {
  const api = useApi();
  const { client } = useKlaud();
  const prefs = usePrefs();
  const selfId = useApp((st) => st.selfId);
  const cache = useApp((st) => st.dirCache);
  const viewer = useApp((st) => st.viewer);
  const browserAt = useApp((st) => st.browser.at);
  const review = useApp((st) => (st.review?.workspaceId === wsId ? st.review.data : undefined));
  const rowItems = useRowItems();
  const share = shareNameOf(wsId);
  const at = (path: string): Location => ({ owner: selfId, share, path });
  const keyOf = (path: string): string => `${selfId}:${share}/${path}`;
  const entriesOf = (path: string): readonly FsEntry[] | undefined => cache[keyOf(path)];

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => opened.get(wsId) ?? new Set());
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const requested = useRef(new Set<string>());

  const load = (path: string): void => {
    requested.current.add(path);
    void api.files.loadDir(at(path));
  };
  const expand = (next: ReadonlySet<string>): void => {
    opened.set(wsId, next);
    setExpanded(next);
  };

  // The folder and every folder you've opened (they refresh each time you come back).
  useEffect(() => {
    for (const p of ['', ...expanded]) load(p);
  }, [wsId, expanded]);

  // Filtering looks a few levels deep (not into node_modules, .git, build output…).
  const q = query.trim();
  useEffect(() => {
    if (!q) return;
    for (const p of filterLoads(entriesOf, requested.current)) load(p);
  }, [q, cache]);

  // A file opened from the chat or a diff: show it in the tree.
  const shown = viewer && viewer.owner === selfId && viewer.share === share ? viewer : undefined;
  useEffect(() => {
    if (!shown) return;
    const up = ancestorsOf(shown.path);
    if (up.some((p) => !expanded.has(p))) expand(new Set([...expanded, ...up]));
    setCursor(shown.path);
  }, [shown?.path]);
  // A folder link from the chat (it browses there): open it in the tree.
  useEffect(() => {
    if (!browserAt || browserAt.owner !== selfId || browserAt.share !== share || !browserAt.path) return;
    expand(new Set([...expanded, ...ancestorsOf(browserAt.path), browserAt.path]));
    setCursor(browserAt.path);
  }, [browserAt?.path, browserAt?.share]);
  useEffect(() => {
    list.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const changes = useMemo(() => {
    const files = new Map((review?.files ?? []).map((x) => [x.path, x.state] as const));
    const dirs = new Set([...files.keys()].flatMap(ancestorsOf));
    return { files, dirs };
  }, [review]);
  const rows = treeRows(entriesOf, expanded, q);

  const toggle = (path: string): void => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expand(next);
  };
  const activate = (row: TreeRow): void => {
    setCursor(row.path);
    if (row.dir) return toggle(row.path);
    void api.files.open(at(row.path));
  };
  const localOf = (path: string): string | undefined => localPathOf(client.store.getState(), at(path));
  const itemsFor = (row: TreeRow): ActionItem[] => {
    const base = rowItems({ label: row.name, dir: row.dir, target: at(row.path) }, () => activate(row));
    const local = localOf(row.path);
    if (row.dir) return base;
    return [
      base[0]!,
      { label: 'Open in Full', icon: 'expand', keys: `${mod()}↩`, onSelect: () => void api.files.open(at(row.path)).then(() => openFocus('file', wsId)) },
      ...(local ? [{ label: 'Open With Its App', icon: 'external' as const, onSelect: () => void openWithDefaultApp(client, local) }] : []),
      ...base.slice(1),
    ];
  };

  const onKey = (e: KeyboardEvent): void => {
    const nav = rows.filter((r) => r.kind === 'entry');
    const i = nav.findIndex((r) => r.path === cursor);
    const row = nav[i];
    const move = (to: number): void => {
      const next = nav[Math.max(0, Math.min(nav.length - 1, to))];
      if (next) setCursor(next.path);
    };
    if (e.key === 'ArrowDown') (e.preventDefault(), move(i + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(i < 0 ? 0 : i - 1));
    else if (e.key === 'ArrowRight' && row?.dir) {
      e.preventDefault();
      if (!expanded.has(row.path)) toggle(row.path);
      else move(i + 1);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (row.dir && expanded.has(row.path)) toggle(row.path);
      else {
        const parent = ancestorsOf(row.path).pop();
        if (parent !== undefined) setCursor(parent);
      }
    } else if (e.key === 'Enter' && row) {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && !row.dir) void api.files.open(at(row.path)).then(() => openFocus('file', wsId));
      else activate(row);
    } else if (e.key === 'Escape' && shown && !focusFor(wsId)) {
      e.preventDefault();
      e.stopPropagation();
      void api.files.closeViewer();
    }
  };

  const split = clampShare(prefs.panelSplit, SPLIT_MIN, SPLIT_MAX);
  const local = shown ? localOf(shown.path) : undefined;
  return (
    <div ref={box} className={s.stack}>
      <div className={s.top} style={shown ? { flex: `0 0 ${Math.round(split * 100)}%` } : undefined}>
        <div className={s.filterRow}>
          <label className={s.filter}>
            <Icon name="search" size={12} />
            <input
              value={query}
              placeholder="Filter by name"
              aria-label="Filter files"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) (e.preventDefault(), e.stopPropagation(), setQuery(''));
                else if (e.key === 'ArrowDown') (e.preventDefault(), list.current?.focus(), setCursor(rows.find((r) => r.kind === 'entry')?.path));
              }}
            />
          </label>
          <IconButton icon="chevronUp" label="Collapse all folders" onClick={() => expand(new Set())} disabled={!expanded.size} />
          <IconButton icon="folder" label="Show in Finder" onClick={() => void api.workspaces.openInFinder(wsId)} />
        </div>
        <div ref={list} className={cx(s.list, s.tree)} role="tree" aria-label="Files" tabIndex={0} onKeyDown={onKey}>
          {rows.map((row) => {
            const state = changes.files.get(row.path);
            const look = state ? STATE[state] : undefined;
            const on = row.path === cursor;
            return row.kind === 'loading' ? (
              <div key={`${row.path}…`} className={s.treeNote} style={{ paddingLeft: 10 + row.depth * 14 + 18 }}>
                Loading…
              </div>
            ) : (
              <ActionsContext key={row.path} items={() => itemsFor(row)}>
                <div
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={on}
                  aria-expanded={row.dir ? row.open : undefined}
                  aria-label={row.name}
                  data-cursor={on}
                  className={cx(s.row, s.treeRow, on && s.rowOn, shown?.path === row.path && s.rowShown)}
                  style={{ paddingLeft: 6 + row.depth * 14 }}
                  title={row.path}
                  onClick={() => activate(row)}
                  onDoubleClick={() => {
                    const p = localOf(row.path);
                    if (!row.dir && p) void openWithDefaultApp(client, p);
                  }}
                >
                  <span className={s.chevron}>{row.dir ? <Icon name={row.open ? 'chevronDown' : 'chevronRight'} size={9} /> : null}</span>
                  <Icon name={row.dir ? 'folder' : 'file'} size={13} className={row.dir ? s.dirIcon : s.fileIcon} />
                  <span className={cx(s.rowName, look?.tone)}>
                    <Marked name={row.name} query={q} />
                  </span>
                  {look ? <span className={cx(d.letter, look.tone)}>{look.letter}</span> : row.dir && changes.dirs.has(row.path) ? <span className={s.changedDot} title="Has changes" /> : null}
                  {!row.dir && !look && row.size !== undefined && on ? <span className={s.size}>{row.size < 1024 ? `${row.size} B` : formatBytes(row.size)}</span> : null}
                </div>
              </ActionsContext>
            );
          })}
          {q && !rows.length ? <div className={s.treeNote}>No names with “{q}” in the folders looked at</div> : null}
        </div>
      </div>
      {shown ? (
        <>
          <ResizeHandle
            axis="y"
            label="Resize the tree"
            onMove={(y) => {
              const r = box.current?.getBoundingClientRect();
              if (r) setPrefs({ panelSplit: clampShare((y - r.top) / r.height, SPLIT_MIN, SPLIT_MAX) });
            }}
            onReset={() => setPrefs({ panelSplit: SPLIT_DEFAULT })}
            onStep={(dir) => setPrefs({ panelSplit: clampShare(split - dir * 0.04, SPLIT_MIN, SPLIT_MAX) })}
          />
          <Preview viewer={shown} wsId={wsId} local={local} />
        </>
      ) : null}
    </div>
  );
}
