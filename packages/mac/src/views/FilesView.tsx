import { useEffect, useRef, useState } from 'react';
import type { BrowserRow, ViewerState } from '@klaud/core/store.js';
import { shareNameOf } from '@klaud/shared/share-names.js';
import { formatBytes } from '@klaud/shared/format.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, IconButton, Segmented, cx } from '../components/ui.js';
import { useApi, useApp, useKlaud } from '../lib/klaud.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { useActions } from '../lib/actions.js';
import { copyText } from '../lib/copy.js';
import { localPathOf, mentionOf, revealInFinder, saveFile } from '../lib/files.js';
import { SearchField, SearchResults } from './SharedSearch.js';
import s from './files.module.css';

export const ext = (p: string): string => /\.([\w-]+)$/.exec(p)?.[1]?.toLowerCase() ?? '';
export const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', json: 'json', sh: 'bash', py: 'python', go: 'go', rs: 'rust', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', sql: 'sql', swift: 'swift', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', rb: 'ruby', toml: 'toml' };

/** A decoded image (RGBA pixels) drawn at its size, scaled down to fit. */
export function Bitmap({ image }: { image: NonNullable<ViewerState['image']> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = image.width;
    c.height = image.height;
    const data = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    c.getContext('2d')?.putImageData(data, 0, 0);
  }, [image]);
  return <canvas ref={ref} className={s.image} />;
}

export function Viewer({ viewer }: { viewer: ViewerState }) {
  const api = useApi();
  const { client } = useKlaud();
  const [raw, setRaw] = useState(false);
  const name = viewer.path.split('/').pop() || viewer.path;
  const markdown = ext(viewer.path) === 'md' || ext(viewer.path) === 'markdown';
  const lang = LANG[ext(viewer.path)];
  return (
    <section className={s.viewer} aria-label={name}>
      <div className={s.viewerHead}>
        <Icon name="file" size={14} />
        <span className={s.viewerName}>{name}</span>
        {viewer.by ? <span className={s.following}>following {viewer.by}</span> : null}
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
        <IconButton icon="download" label="Save a copy…" onClick={() => void saveFile(client, viewer)} />
        <IconButton icon="x" label="Close" onClick={() => void api.files.closeViewer()} />
      </div>
      <div className={s.viewerBody}>
        {viewer.loading && !viewer.content && !viewer.image ? (
          <div className={s.loading}>Opening…</div>
        ) : viewer.error ? (
          <Empty icon="alert" title="Can't open this file" detail={viewer.error} />
        ) : viewer.image ? (
          <div className={s.imageWrap}>
            <Bitmap image={viewer.image} />
          </div>
        ) : markdown && !raw ? (
          <div className={s.doc}>
            <Markdown text={viewer.content} />
          </div>
        ) : (
          <div className={s.codeWrap}>
            <Markdown text={fenced(viewer.content, lang)} />
          </div>
        )}
        {viewer.truncated ? <div className={s.truncated}>Only the beginning is shown. Download it for the rest.</div> : null}
      </div>
    </section>
  );
}

/** A file as one code block: the fence is longer than any run of backticks in it, so it can't end early. */
export function fenced(content: string, lang: string | undefined): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang ?? 'text'}\n${content}\n${fence}`;
}

/** Right-click on a file or folder: open it, find it in Finder, copy its path, mention it, save it. */
export function useRowItems(): (row: BrowserRow, onOpen: () => void) => ActionItem[] {
  const { client, ui } = useKlaud();
  const actions = useActions();
  return (row, onOpen) => {
    if (row.target === 'up') return [{ label: 'Back', icon: 'back', onSelect: onOpen }];
    const at = row.target;
    const state = client.store.getState();
    const local = localPathOf(state, at);
    const say = (text: string): void => client.store.dispatch({ type: 'toast', text, level: 'success' });
    const mention = (): void => {
      const v = state.view;
      // The conversation this folder belongs to (a workspace's own chat, else the room).
      if (v.kind === 'workspace') actions.run({ type: 'open_ws', id: v.id, tab: 'chat' });
      else if (v.kind === 'shared') actions.run({ type: 'open_shared', owner: v.owner, id: v.id, tab: 'chat' });
      else actions.run({ type: 'view', view: { kind: 'room' } });
      const current = ui.get().buffer;
      const buffer = `${current}${current && !current.endsWith(' ') ? ' ' : ''}${mentionOf(state, at)} `;
      setTimeout(() => {
        ui.patch({ buffer, cursor: buffer.length });
        document.dispatchEvent(new CustomEvent('klaud:focus-composer'));
      }, 60);
    };
    return [
      { label: row.dir ? 'Open Folder' : 'Open', icon: row.dir ? 'folder' : 'file', onSelect: onOpen },
      ...(local ? [{ label: 'Show in Finder', icon: 'folder' as const, onSelect: () => void revealInFinder(client, local) }] : []),
      { label: 'Copy Path', icon: 'copy', separate: true, onSelect: () => void copyText(local ?? mentionOf(state, at)).then(() => say('Copied the path')) },
      { label: 'Mention in Chat', icon: 'chat', onSelect: mention },
      ...(row.dir ? [] : [{ label: 'Save a Copy…', icon: 'download' as const, separate: true, onSelect: () => void saveFile(client, at) }]),
    ];
  };
}

function Row({ row, selected, onOpen }: { row: BrowserRow; selected: boolean; onOpen: () => void }) {
  const up = row.target === 'up';
  const items = useRowItems();
  return (
    <ActionsContext items={() => items(row, onOpen)}>
    <div role="option" aria-selected={selected} tabIndex={-1} className={cx(s.row, selected && s.rowOn)} onClick={onOpen} title={row.label}>
      <Icon name={up ? 'up' : row.dir ? 'folder' : 'file'} size={14} className={row.dir ? s.dirIcon : s.fileIcon} />
      <span className={s.rowName}>{up ? 'Back' : row.label}</span>
      {!row.dir && row.size !== undefined ? <span className={s.size}>{row.size < 1024 ? `${row.size} B` : formatBytes(row.size)}</span> : null}
      {row.dir && !up ? <Icon name="chevronRight" size={10} className={s.chev} /> : null}
    </div>
    </ActionsContext>
  );
}

/** Shared files (everyone's folders), or a workspace's own Files tab. */
export function FilesView() {
  const api = useApi();
  const { client, ui } = useKlaud();
  const home = useApp((st) => st.home);
  const myShares = useApp((st) => st.myShares);
  const view = useApp((st) => st.view);
  const browser = useApp((st) => st.browser);
  const viewer = useApp((st) => st.viewer);
  const selfId = useApp((st) => st.selfId);
  const shared = useApp((st) => st.shared);
  const list = useRef<HTMLDivElement>(null);
  // Arrow keys move the selection; keep it in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [browser.cursor]);

  // A workspace's Files tab starts at its folder.
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  useEffect(() => {
    if (wsId) void api.files.browseTo({ owner: selfId, share: shareNameOf(wsId), path: '' });
  }, [wsId]);

  // A workspace shared with you: its files, and a search over them (names and contents).
  const sharedWs = view.kind === 'shared' ? shared.find((w) => w.id === view.id && w.owner === view.owner) : undefined;
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState<string>();
  useEffect(() => {
    setTyped('');
    setSearch(undefined);
    if (sharedWs && browser.at?.share !== sharedWs.share) void api.files.browseTo({ owner: sharedWs.owner, share: sharedWs.share, path: '' });
  }, [sharedWs?.id]);

  const open = (i: number): void => {
    client.store.dispatch({ type: 'browser_cursor', delta: i - browser.cursor });
    void api.files.enter(i);
  };
  const crumbs = browser.at ? [browser.at.share.startsWith('ws-') ? (shared.find((w) => w.share === browser.at!.share)?.name ?? 'This workspace') : browser.at.share, ...browser.at.path.split('/').filter(Boolean)] : ['Everything shared with you'];

  return (
    <div className={s.files}>
      <section className={s.browser} aria-label="Files">
        {sharedWs ? <SearchField value={typed} onChange={setTyped} onSearch={setSearch} /> : null}
        <div className={s.crumbs}>
          {(sharedWs && search ? [`Results for “${search}”`] : crumbs).map((c, i) => (
            <span key={i} className={s.crumb}>
              {i ? <Icon name="chevronRight" size={9} /> : null}
              {/* Every folder above this one is a click away. */}
              {browser.at && !search && i < crumbs.length - 1 ? (
                <button type="button" className={s.crumbLink} onClick={() => void api.files.browseTo({ ...browser.at!, path: crumbs.slice(1, i + 1).join('/') })}>
                  {c}
                </button>
              ) : (
                c
              )}
            </span>
          ))}
          {browser.loading ? <span className={s.dim}>…</span> : null}
        </div>
        {sharedWs && search ? (
          <SearchResults id={sharedWs.id} owner={sharedWs.owner} share={sharedWs.share} query={search} />
        ) : (
        <div
          ref={list}
          className={s.list}
          role="listbox"
          tabIndex={0}
          aria-label="Files"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              client.store.dispatch({ type: 'browser_cursor', delta: e.key === 'ArrowDown' ? 1 : -1 });
            } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
              e.preventDefault();
              void api.files.enter(browser.cursor);
            } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
              e.preventDefault();
              void api.files.up();
            }
          }}
        >
          {browser.error ? <div className={s.error}>{browser.error}</div> : null}
          {browser.rows.length ? (
            browser.rows.map((r, i) => <Row key={`${r.label}:${i}`} row={r} selected={i === browser.cursor} onOpen={() => open(i)} />)
          ) : browser.loading ? null : (
            <Empty icon="folder" title={browser.at ? 'This folder is empty' : 'Nothing shared yet'} detail={browser.at ? undefined : 'When people in the room share folders, they show up here.'} action={browser.at ? undefined : <Button onClick={() => ui.openMenu({ kind: 'share_folder', launchDir: home, mine: myShares })}>Share a folder…</Button>} />
          )}
        </div>
        )}
      </section>
      {viewer ? <Viewer viewer={viewer} /> : <div className={s.noViewer}><Empty icon="file" title="Pick a file to open it" detail="Markdown shows formatted, code with colors, images as they are. Files update live when they change." /></div>}
    </div>
  );
}
