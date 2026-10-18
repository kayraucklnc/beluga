import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, cx } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { pickFolders } from '../lib/projects.js';
import s from './add-project.module.css';

interface Found {
  readonly path: string;
  readonly name: string;
  readonly changed: number;
}

const ago = (ts: number): string => {
  const d = Math.max(0, (Date.now() - ts) / 1000);
  if (d < 3600) return 'just now';
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86_400 * 30) return `${Math.floor(d / 86_400)}d ago`;
  return `${Math.floor(d / (86_400 * 30))}mo ago`;
};

/**
 * Add projects the Mac way: drop folders on it, choose them in the Open panel, or pick from the
 * git projects already on this Mac (most recently worked on first).
 */
export function AddProjectSheet() {
  const { ui } = useKlaud();
  const api = useApi();
  const open = useUi((u) => u.addProject ?? false);
  const home = useApp((st) => st.home);
  const roots = useApp((st) => st.projects.map((p) => p.root).filter(Boolean).join('\n'));
  // Projects you hid: listed too, with Show (they come back where they were).
  const hidden = useApp((st) => st.hiddenProjects.join('\n'));
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [found, setFound] = useState<Found[] | undefined>();
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const [over, setOver] = useState(false);
  const filterBox = useRef<HTMLInputElement>(null);
  const close = (): void => ui.patch({ addProject: false });
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  useEffect(() => {
    if (!open) return;
    setAdded(new Set());
    setRevealed(new Set());
    setFilter('');
    setFound(undefined);
    void api.projects.suggest().then(setFound, () => setFound([]));
  }, [open]);

  const add = async (paths: readonly string[]): Promise<void> => {
    for (const p of paths) await api.projects.add(p);
    setAdded((a) => new Set([...a, ...paths]));
  };

  // Folders dropped anywhere on the window while this is open are added.
  useEffect(() => {
    if (!open || !inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'over' || e.payload.type === 'enter') setOver(true);
        else if (e.payload.type === 'leave') setOver(false);
        else if (e.payload.type === 'drop') {
          setOver(false);
          void add(e.payload.paths);
        }
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [open]);

  const show = async (path: string): Promise<void> => {
    if (await api.workspaces.showProject(path)) setRevealed((r) => new Set([...r, path]));
  };

  const hiddenSet = useMemo(() => new Set(hidden.split('\n').filter(Boolean)), [hidden]);
  const shown = useMemo(() => {
    const known = new Set(roots.split('\n'));
    const q = filter.trim().toLowerCase();
    const listed = new Set((found ?? []).map((f) => f.path));
    const hiddenOnly = found ? [...hiddenSet, ...revealed].filter((p, i, all) => !listed.has(p) && all.indexOf(p) === i).map((p): Found => ({ path: p, name: p.split('/').filter(Boolean).pop() ?? p, changed: 0 })) : [];
    return [...hiddenOnly, ...(found ?? [])]
      .filter((f) => !known.has(f.path) || added.has(f.path) || revealed.has(f.path))
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [found, filter, roots, added, hiddenSet, revealed]);

  const choose = async (): Promise<void> => {
    const picked = await pickFolders('Add projects');
    if (picked) await add(picked);
  };

  if (!open) return null;
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined} onOpenAutoFocus={(e) => (e.preventDefault(), filterBox.current?.focus())}>
          <div className={s.head}>
            <Dialog.Title className={s.title}>Add projects</Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={11} />
            </Dialog.Close>
          </div>

          <div
            className={cx(s.drop, over && s.dropOver)}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => (e.preventDefault(), setOver(false))}
          >
            <Icon name="folder" size={22} />
            <div className={s.dropText}>
              <strong>Drop project folders here</strong>
              <span>A git project, or a folder full of them (new ones in it show up too).</span>
            </div>
            {inApp() ? (
              <Button variant="primary" onClick={() => void choose()}>
                Choose Folders…
              </Button>
            ) : null}
          </div>

          <div className={s.listHead}>
            <span>On this Mac</span>
            <input ref={filterBox} className={s.filter} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter projects on this Mac" />
          </div>
          <div className={s.list} role="list">
            {found === undefined ? (
              <div className={s.note}>Looking in your code folders…</div>
            ) : shown.length === 0 ? (
              <div className={s.note}>{filter ? `Nothing called “${filter}”.` : 'No other git projects in ~/Projects, ~/Developer, ~/code and the like.'}</div>
            ) : (
              shown.map((f) => {
                const done = added.has(f.path) || revealed.has(f.path);
                const wasHidden = hiddenSet.has(f.path) || revealed.has(f.path);
                return (
                  <div key={f.path} className={s.item} role="listitem" onDoubleClick={() => !done && void (wasHidden ? show(f.path) : add([f.path]))}>
                    <ProjectIcon id={`path:${f.path}`} name={f.name} size={26} />
                    <span className={s.itemText}>
                      <span className={s.itemName}>{f.name}</span>
                      <span className={s.itemPath}>
                        {short(f.path)} · {wasHidden ? 'hidden' : ago(f.changed)}
                      </span>
                    </span>
                    {done ? (
                      <span className={s.added}>
                        <Icon name="check" size={12} /> {wasHidden ? 'Showing' : 'Added'}
                      </span>
                    ) : wasHidden ? (
                      <Button size="small" onClick={() => void show(f.path)} aria-label={`Show ${f.name}`}>
                        Show
                      </Button>
                    ) : (
                      <Button size="small" onClick={() => void add([f.path])}>
                        Add
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <form
            className={s.pathRow}
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed.trim()) return;
              void add([typed.trim()]);
              setTyped('');
            }}
          >
            <input className={s.path} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type a path, like ~/code/app" aria-label="Folder path" spellCheck={false} />
            <Button size="small" type="submit" disabled={!typed.trim()}>
              Add
            </Button>
            <span className={s.flex} />
            <Button variant={added.size || revealed.size ? 'primary' : 'quiet'} onClick={close}>
              {added.size || revealed.size ? 'Done' : 'Cancel'}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
