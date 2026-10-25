import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Location } from '@beluga/core/store.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { SHOWN_SCRATCH_DIRS } from '@beluga/shared/scratch-dir.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Empty, IconButton, cx } from '../../components/ui.js';
import { ActionsDropdown } from '../../components/SpecMenu.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { openWithDefaultApp, revealInFinder } from '../../lib/files.js';
import { openFocus } from '../../lib/panel.js';
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampShare } from '../../lib/panel-model.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import { mod } from '../../lib/system.js';
import { ChangedFileView } from '../../views/ChangedFile.js';
import { signalOf } from '../attention-model.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NextFileRow, ScratchEmpty, ScratchSkeleton } from './ScratchSkeleton.js';
import { type ScratchEntry, type ScratchKind, type ScratchSort, atEnd, fileKind, followed, foldersWithFiles, isFresh, isViewable, scratchPlace, scratchState, sortScratch, timeAgo } from './scratch-model.js';
import s from './panel.module.css';
import k from './scratch.module.css';

/**
 * The right panel's Scratch: what Claude saves to the workspace's `.beluga/scratch/` (or `.context/`,
 * when another tool runs it there) while it works: screenshots, JSON, logs, notes, newest first and
 * live (or, from the sort menu, what can be looked at first: pictures, videos, PDFs, web pages).
 * The preview shows the newest file until you pick one, then stays on it. Scrolled to its end
 * (or with the to-the-end button), it follows the file: what's written to it stays in sight. While
 * the first look is on its way it's drawn in outline; an empty folder says so, calmly.
 */

const POLL_MS = 1200;
const ICONS: Record<ScratchKind, IconName> = { image: 'image', pdf: 'file', video: 'play', html: 'globe', json: 'file', markdown: 'file', text: 'file' };

interface Listing {
  readonly root: string;
  readonly dir: string;
  readonly files: readonly ScratchEntry[];
}

/**
 * The folder's files, looked at again every moment while the window is in front. It changes only
 * when they do; a late answer never replaces a newer one; a failed look keeps what's on screen.
 */
function useScratch(wsId: string): Listing | undefined | null {
  const api = useApi();
  const [list, setList] = useState<Listing | null>();
  useEffect(() => {
    let alive = true;
    let asked = 0;
    let shown = 0;
    let sig: string | undefined;
    setList(undefined);
    const look = (): void => {
      if (document.visibilityState !== 'visible') return;
      const n = ++asked;
      api.workspaces.scratch(wsId).then(
        (res) => {
          if (!alive || n < shown) return;
          shown = n;
          const next = res ? { root: res.root, dir: res.dir, files: res.files } : null;
          const key = next ? `${next.dir}\n${next.files.map((f) => `${f.path}:${f.mtime}:${f.size}`).join('|')}` : 'none';
          if (key === sig) return;
          sig = key;
          setList(next);
        },
        () => {
          // Nothing yet: say so; otherwise keep the last listing until the next look.
          if (alive && sig === undefined) setList(null);
        },
      );
    };
    look();
    const timer = setInterval(look, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [wsId]);
  return list;
}

/** How often the Scratch tab's dot looks for something new (while the window is in front). */
const NEWEST_MS = 4000;

/** When Claude last saved something to this workspace's scratch folder (0: nothing there; undefined: not looked yet). */
export function useScratchNewest(wsId: string | undefined): number | undefined {
  const api = useApi();
  const [newest, setNewest] = useState<number>();
  useEffect(() => {
    setNewest(undefined);
    if (!wsId) return;
    let alive = true;
    const look = (): void => {
      if (document.visibilityState !== 'visible') return;
      api.workspaces.scratch(wsId).then(
        (res) => alive && setNewest(Math.max(0, ...(res?.files ?? []).map((f) => f.mtime))),
        () => undefined,
      );
    };
    look();
    const timer = setInterval(look, NEWEST_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [wsId]);
  return newest;
}

/** "now", "12s", "3m": kept current without a new listing. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Following a file's end: on once you scroll to the bottom (or ask), off when you scroll up. While
 * on, whatever is written to the file stays in sight: the content is updated in place and the view
 * just kept at its end. Each file opens at its top, not following.
 */
function useFollowEnd(body: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, path: string) {
  const [follow, setFollow] = useState(false);
  const on = useRef(false);
  const set = (v: boolean): void => {
    on.current = v;
    setFollow(v);
  };
  const toEnd = (): void => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // Another file: back to its top.
  useLayoutEffect(() => {
    set(false);
    if (body.current) body.current.scrollTop = 0;
  }, [path]);
  // It grew (or shrank): kept at the end while following.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (on.current) toEnd();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = (): void => {
    const el = body.current;
    if (!el) return;
    const end = atEnd(el);
    if (end !== on.current) set(end);
  };
  const followEnd = (): void => {
    set(true);
    toEnd();
  };
  return { follow, onScroll, followEnd };
}

function Preview({ wsId, file, root, onClose }: { wsId: string; file: ScratchEntry; root: string; onClose: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const selfId = useApp((st) => st.selfId);
  const now = useNow();
  const at: Location = { owner: selfId, share: shareNameOf(wsId), path: file.path };
  const name = file.path.split('/').pop() ?? file.path;
  const local = `${root}/${file.path}`;
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { follow, onScroll, followEnd } = useFollowEnd(body, content, file.path);
  return (
    <section className={s.preview} aria-label={name}>
      <div className={s.previewHead}>
        <Icon name={ICONS[fileKind(file.path)]} size={13} className={s.fileIcon} />
        <span className={s.previewName} title={file.path}>
          {name}
        </span>
        <span className={s.previewDir}>{timeAgo(file.mtime, Math.max(now, Date.now()))}</span>
        <span className={s.flex} />
        {isViewable(file.path) ? null : <IconButton icon="toEnd" label="Follow the End" active={follow} onClick={followEnd} />}
        <IconButton icon="external" label="Open With Its App" onClick={() => void openWithDefaultApp(client, local)} />
        <IconButton icon="expand" label="Open in full" keys={`${mod()}↩`} onClick={() => void api.files.open(at).then(() => openFocus('file', wsId))} />
        <IconButton icon="x" label="Close" keys="Esc" onClick={onClose} />
      </div>
      <div ref={body} className={cx(s.previewBody, s.previewFile, 'selectable')} tabIndex={0} onScroll={onScroll}>
        {/* Kept as it is while the file changes (its text updated in place), so following doesn't flicker. */}
        <div ref={content} className={s.previewContent}>
          <ChangedFileView key={file.path} at={at} variant="panel" version={file.mtime} />
        </div>
      </div>
    </section>
  );
}

export function ScratchTab({ wsId }: { wsId: string }) {
  const { client } = useBeluga();
  const prefs = usePrefs();
  const on = useApp((st) => st.prefs.scratchFolder);
  const working = useApp((st) => signalOf(st, `ws:${wsId}`, wsId).working);
  const list = useScratch(wsId);
  const now = useNow();
  const [picked, setPicked] = useState<string>();
  const [closed, setClosed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const files = list?.files ?? [];
  const sort: ScratchSort = prefs.scratchSort === 'viewable' ? 'viewable' : 'newest';
  // The list in the order picked (the preview still follows the newest file until you pick one).
  const rows = useMemo(() => sortScratch(files, sort), [list, sort]);
  // Nothing picked: the newest file, as each lands. Picked: that one, while it's there.
  const shown = closed ? undefined : followed(files, !picked, picked);
  const file = files.find((f) => f.path === shown);
  const root = list?.root ?? '';

  // Nothing picked: the newest file stays in sight as new ones arrive.
  useEffect(() => {
    if (!picked) listRef.current?.scrollTo({ top: 0 });
  }, [picked, files[0]?.path, files[0]?.mtime]);

  // The arrows move the highlight; the list scrolls to keep it in sight.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [shown]);

  const pick = (path: string): void => {
    setClosed(false);
    setPicked(path);
  };
  const onKey = (e: KeyboardEvent): void => {
    const i = rows.findIndex((f) => f.path === shown);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) pick(next.path);
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault();
      e.stopPropagation();
      setClosed(true);
    }
  };

  const state = scratchState(list);
  if (state === 'loading') return <ScratchSkeleton />;
  if (state === 'missing' || !list) return <Empty icon="alert" title="No folder to look in" detail="This workspace’s folder is missing." />;
  if (state === 'empty') return <ScratchEmpty working={working} folders={SHOWN_SCRATCH_DIRS} off={!on} dir={list.dir} onReveal={() => void revealInFinder(client, list.dir)} />;
  const split = clampShare(prefs.panelSplit, SPLIT_MIN, SPLIT_MAX);
  return (
    <div ref={box} className={s.stack}>
      <div className={s.top} style={file ? { flex: `0 0 ${Math.round(split * 100)}%` } : undefined}>
        <div className={s.summary}>
          <div className={s.summaryRow}>
            <span className={s.summaryTitle}>
              {files.length} file{files.length === 1 ? '' : 's'}
            </span>
            <span className={s.dim}>{foldersWithFiles(files, SHOWN_SCRATCH_DIRS).join(' · ')}</span>
            <span className={s.flex} />
            <ActionsDropdown
              items={[
                { label: 'Newest First', icon: 'clock', checked: sort === 'newest', onSelect: () => setPrefs({ scratchSort: 'newest' }) },
                { label: 'Viewable First', hint: 'Pictures, videos, PDFs and web pages on top', icon: 'eye', checked: sort === 'viewable', onSelect: () => setPrefs({ scratchSort: 'viewable' }) },
              ]}
            >
              <IconButton icon={sort === 'viewable' ? 'eye' : 'clock'} label={sort === 'viewable' ? 'Sorted: viewable first' : 'Sorted: newest first'} />
            </ActionsDropdown>
            <IconButton icon="folder" label="Show in Finder" onClick={() => void revealInFinder(client, list.dir)} />
          </div>
        </div>
        {working ? <NextFileRow /> : null}
        <div ref={listRef} className={s.list} role="listbox" aria-label="Scratch files" tabIndex={0} onKeyDown={onKey}>
          {rows.map((f) => {
            const { root: folder, dir, name } = scratchPlace(f.path, SHOWN_SCRATCH_DIRS);
            const sel = f.path === shown;
            const fresh = isFresh(f.mtime, Math.max(now, Date.now()));
            return (
              <div
                // By path: written again, the row moves up as it is (not drawn anew, sliding in again).
                key={f.path}
                role="option"
                aria-selected={sel}
                className={cx(s.row, sel && s.rowOn, fresh && k.arrived)}
                title={f.path}
                onClick={() => pick(f.path)}
              >
                <Icon name={ICONS[fileKind(f.path)]} size={13} className={s.fileIcon} />
                <span className={s.rowName}>
                  {name}
                  {dir ? <span className={s.rowDir}>{dir}</span> : null}
                </span>
                {folder !== SHOWN_SCRATCH_DIRS[0] ? <span className={k.folder}>{folder}</span> : null}
                {fresh ? <span className={s.freshDot} aria-label="new" /> : null}
                <span className={s.size}>{f.size < 1024 ? `${f.size} B` : formatBytes(f.size)}</span>
                <span className={s.ago}>{timeAgo(f.mtime, Math.max(now, Date.now()))}</span>
              </div>
            );
          })}
        </div>
      </div>
      {file ? (
        <>
          <ResizeHandle
            axis="y"
            label="Resize the list"
            onMove={(y) => {
              const r = box.current?.getBoundingClientRect();
              if (r) setPrefs({ panelSplit: clampShare((y - r.top) / r.height, SPLIT_MIN, SPLIT_MAX) });
            }}
            onReset={() => setPrefs({ panelSplit: SPLIT_DEFAULT })}
            onStep={(dir) => setPrefs({ panelSplit: clampShare(split - dir * 0.04, SPLIT_MIN, SPLIT_MAX) })}
          />
          <Preview wsId={wsId} file={file} root={root} onClose={() => setClosed(true)} />
        </>
      ) : null}
    </div>
  );
}
