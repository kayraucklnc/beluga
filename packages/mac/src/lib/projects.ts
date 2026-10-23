import { useEffect, useState } from 'react';
import type { BelugaClient } from '@klaud/ipc/client.js';
import { inApp } from './boot.js';
import { useKlaud } from './klaud.js';

/** A project's icon as an image URL, or null when it has none (it gets its initial instead). */
type Icon = string | null;

// Read once per project per window; changing it (Change Icon…) reads it again.
const cache = new Map<string, Promise<Icon>>();
const listeners = new Set<(projectId: string) => void>();

function load(client: BelugaClient, key: string): Promise<Icon> {
  let p = cache.get(key);
  if (!p) {
    // "path:/…" is a folder that isn't a project yet.
    const read = key.startsWith('path:') ? client.api.projects.iconAt(key.slice(5)) : client.api.projects.icon(key);
    p = read.then(
      (icon) => (icon ? `data:${icon.mime};base64,${icon.data}` : null),
      () => null,
    );
    cache.set(key, p);
  }
  return p;
}

/** Forget a project's icon so it's read again everywhere it shows. */
export function reloadProjectIcon(projectId: string): void {
  cache.delete(projectId);
  for (const l of [...listeners]) l(projectId);
}

export function useProjectIcon(projectId: string): Icon | undefined {
  const { client } = useKlaud();
  const [icon, setIcon] = useState<Icon | undefined>(undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const l = (id: string): void => void (id === projectId && setVersion((v) => v + 1));
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    void load(client, projectId).then((i) => alive && setIcon(i));
    return () => {
      alive = false;
    };
  }, [client, projectId, version]);
  return icon;
}

/** Choose folders with the Mac's own Open panel (undefined outside the app, or when cancelled). */
export async function pickFolders(title: string): Promise<string[] | undefined> {
  if (!inApp()) return undefined;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: true, title });
  if (!picked) return undefined;
  return Array.isArray(picked) ? picked : [picked];
}

/** Choose an image file with the Open panel. */
export async function pickImage(title: string): Promise<string | undefined> {
  if (!inApp()) return undefined;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, title, filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'ico'] }] });
  return typeof picked === 'string' ? picked : undefined;
}
