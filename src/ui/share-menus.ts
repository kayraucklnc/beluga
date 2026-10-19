import type { AppState } from '../core/store.js';
import type { MenuOption, MenuSpec } from './menus.js';

// Plain string paths (this runs in the Mac app's web view too).
const norm = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const baseName = (p: string): string => norm(p).split('/').pop() ?? p;
const tildeIn = (home: string) => (p: string): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** "Share a folder": this folder, one of your projects, or any path, then who sees it. */
export function shareFolderMenu(state: AppState, launchDir: string, mine: ReadonlyArray<{ name: string; root?: string; private?: boolean; allowed?: readonly string[] }>): MenuSpec {
  const tilde = tildeIn(state.home);
  const sharedRoots = new Set(mine.filter((s) => s.root).map((s) => norm(s.root as string)));
  const candidates = [
    { dir: launchDir, label: `This folder · ${tilde(launchDir)}` },
    ...state.projects.filter((p) => p.root && norm(p.root) !== norm(launchDir)).slice(0, 12).map((p) => ({ dir: p.root, label: `${p.name} · ${tilde(p.root)}` })),
  ];
  const nameOf = (id: string) => state.peers.find((p) => p.peerId === id)?.name ?? '?';
  const options: MenuOption[] = [
    ...candidates.map((c) => ({ id: `sf-dir:${c.dir}`, label: c.label, hint: sharedRoots.has(norm(c.dir)) ? 'shared now · pick to change who sees it' : '' })),
    { id: 'sf-type', label: 'Another folder…', hint: 'type a path (Tab completes)' },
    ...mine
      .filter((s) => !s.name.startsWith('ws-'))
      .map((s) => ({ id: `sf-stop:${s.name}`, label: `Stop sharing ${s.name}`, hint: s.private ? `with ${(s.allowed ?? []).map(nameOf).join(', ') || 'nobody'}` : 'with everyone' })),
    { id: 'close', label: 'Close', hint: 'Esc' },
  ];
  return {
    title: 'Share a folder',
    intro: ['Pick a folder, then who can see it. Friends can browse, open and download files; .env files, keys and', 'other secrets are never shared. You can stop sharing any time.'],
    options,
  };
}

/** Second step: who sees the folder, and whether Claude may edit there. */
export function shareWhoMenu(state: AppState, dir: string): MenuSpec {
  const people = state.peers.filter((p) => p.peerId !== state.self?.peerId);
  return {
    title: `Share ${baseName(dir) || dir} with…`,
    intro: [tildeIn(state.home)(dir)],
    options: [
      { id: 'sw-all', label: 'Everyone in the room', hint: 'read-only' },
      ...people.map((p) => ({ id: `sw-peer:${p.peerId}`, label: `Only ${p.name}`, hint: 'read-only, nobody else sees it' })),
      { id: 'sw-all-rw', label: 'Everyone, and my Claude may edit files there', hint: 'for folders you work on together' },
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}
