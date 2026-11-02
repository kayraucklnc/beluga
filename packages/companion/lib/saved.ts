import { Image } from 'expo-image';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform, Share } from 'react-native';
import { kv } from './kv';
import { calls } from './link/calls';
import type { OutputView } from './link/protocol';
import { type SavedFile, freeName, split, topicsOf } from './saved-list';
import { CACHE_DIRS, cacheBytes, clearCacheDirs } from './sink';
import { store } from './store';

export type { SavedFile } from './saved-list';

/**
 * Saving outputs on the phone, and keeping what they take in check (BLG-122).
 *
 * Android: into a folder you pick once (Pictures › Beluga, say), through the system's folder
 * access: the gallery shows the pictures and videos there, the Files app the rest, and the app may
 * delete what it put there without asking each time. iPhone: the share sheet (Save Image, Save to
 * Files), which the app can't take back, so nothing is kept track of there.
 *
 * Every save is noted with the conversation it came from. When the link opens, the Mac is asked
 * which of those conversations are archived or deleted (`companion.gone`), and their files go
 * (unless Settings › Storage says to keep them). The cache holds nothing from an earlier launch, so
 * it's emptied as the app starts.
 */

const LIST = 'saved';
const FOLDER = 'savedFolder';
const CLEANUP = 'savedCleanup';
/** Where the folder picker opens: Pictures, so the gallery finds what's saved. */
const PICTURES = 'content://com.android.externalstorage.documents/document/primary%3APictures';

const listeners = new Set<() => void>();
let list: readonly SavedFile[] = kv.get<SavedFile[]>(LIST) ?? [];

function setList(next: readonly SavedFile[]): void {
  list = next;
  kv.set(LIST, next);
  for (const fn of [...listeners]) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** What's saved on this phone, the newest last. */
export const useSaved = (): readonly SavedFile[] => useSyncExternalStore(subscribe, () => list);
export const savedNow = (): readonly SavedFile[] => list;

/** Saved files go when their conversation is archived or deleted on the Mac (on unless you turned it off). */
export const cleanupOn = (): boolean => kv.get<boolean>(CLEANUP) !== false;
export function setCleanup(on: boolean): void {
  kv.set(CLEANUP, on);
  if (on) void cleanUp();
}

/** Can this phone save into its storage itself (and so take it back)? */
export const keepsTrack = Platform.OS === 'android';

// ---- the folder (Android)

/** The folder you picked, while the app may still write there. */
export function savedFolder(): Directory | undefined {
  const uri = kv.get<string>(FOLDER);
  if (!uri) return undefined;
  try {
    const dir = new Directory(uri);
    return dir.exists ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Its name, for Settings ("Beluga"). */
export function folderName(): string | undefined {
  try {
    return savedFolder()?.name || undefined;
  } catch {
    return undefined;
  }
}

/** Pick (or change) the folder: undefined when you backed out. */
export async function pickFolder(): Promise<Directory | undefined> {
  try {
    const dir = await Directory.pickDirectoryAsync(savedFolder()?.uri ?? PICTURES);
    kv.set(FOLDER, dir.uri);
    for (const fn of [...listeners]) fn();
    return dir;
  } catch {
    return undefined;
  }
}

// ---- saving

const isText = (o: OutputView): boolean => o.kind === 'text' || o.kind === 'json' || o.kind === 'markdown';

/**
 * A text output whole, as the reader shows it: page by page, with the secrets a log printed
 * redacted by the Mac (never the raw bytes, which `full` would be).
 */
function wholeText(ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let last = -1;
    const check = (): void => {
      const f = store.file(ref, 'text');
      if (!f || f.status === 'loading') return;
      if (f.status === 'error') {
        unsub();
        reject(new Error(f.error ?? 'Couldn’t get it.'));
      } else if (f.size !== undefined && f.got < f.size && f.got > last) {
        last = f.got;
        store.fetch(ref, 'text', true);
      } else {
        unsub();
        resolve(f.text ?? '');
      }
    };
    const unsub = store.subscribe(`file:${ref}#text`, check);
    store.fetch(ref, 'text');
    check();
  });
}

/** A file on the phone with the whole output in it, and whether it's ours to delete after. */
async function localCopy(o: OutputView): Promise<{ file: File; temp: boolean }> {
  const full = o.kind === 'image' ? store.file(o.ref, 'full') : undefined;
  if (full?.status === 'ready' && full.uri?.startsWith('file:')) return { file: new File(full.uri), temp: false };
  if (isText(o)) {
    const text = await wholeText(o.ref);
    const dir = new Directory(Paths.cache, CACHE_DIRS.save);
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `text-${Date.now()}`);
    file.create({ overwrite: true });
    await file.write(text);
    return { file, temp: true };
  }
  return { file: new File(await store.saveCopy(o.ref)), temp: true };
}

/**
 * Save an output on the phone (the viewer's Save). Says how it went in a toast; resolves once it's
 * done or failed.
 */
export async function saveOutput(o: OutputView, topic?: string): Promise<void> {
  if (Platform.OS === 'web') return void store.toast({ text: 'Saving works in the phone app.', tone: 'info' });
  let folder: Directory | undefined;
  if (keepsTrack) {
    folder = savedFolder();
    if (!folder) {
      store.toast({ text: 'Pick a folder for what you save: make one called Beluga in Pictures.', tone: 'info' });
      folder = await pickFolder();
      if (!folder) return;
    }
  }
  let stage: Directory | undefined;
  let copy: { file: File; temp: boolean } | undefined;
  try {
    copy = await localCopy(o);
    if (!folder) {
      // iPhone: the share sheet saves it (Save Image, Save to Files).
      await Share.share({ url: copy.file.uri });
      return;
    }
    const taken = new Set(folder.list().map((e) => e.name));
    const name = freeName(o.name, taken);
    // Copied under its own name (a copy into a folder keeps the name it has).
    stage = new Directory(Paths.cache, CACHE_DIRS.save, `to-${Date.now()}`);
    stage.create({ intermediates: true, idempotent: true });
    const named = new File(stage, name);
    if (copy.temp) await copy.file.move(named);
    else await copy.file.copy(named);
    await named.copy(folder);
    const saved = folder.list().find((e): e is File => e instanceof File && e.name === name);
    if (saved) setList([...list, { uri: saved.uri, name, kind: o.kind, size: named.size || o.size || 0, at: Date.now(), ...(topic ? { topic } : {}) }]);
    store.toast({ text: `Saved ${name} to ${folder.name || 'your folder'}`, tone: 'ok' });
  } catch (e) {
    const why = (e as Error).message;
    store.toast({ text: /permission|denied|security/i.test(why) ? 'The app can’t write to that folder any more: pick it again in Settings › Storage.' : `Couldn’t save it: ${why}`, tone: 'error' });
  } finally {
    store.doneSaving(o.ref);
    try {
      if (stage?.exists) stage.delete();
      if (copy?.temp && copy.file.exists) copy.file.delete();
    } catch {
      // the next launch empties the cache
    }
  }
}

// ---- taking them back

/** Delete saved files from the phone (the ones already gone just leave the list). */
export function removeSaved(which: readonly SavedFile[]): number {
  const uris = new Set(which.map((s) => s.uri));
  let n = 0;
  for (const s of which) {
    try {
      const f = new File(s.uri);
      if (f.exists) {
        f.delete();
        n++;
      }
    } catch {
      // not ours any more (the folder's access was taken back): it leaves the list all the same
    }
  }
  setList(list.filter((s) => !uris.has(s.uri)));
  return n;
}

/** Forget the files you deleted yourself (in the gallery, in Files). */
export function prune(): void {
  const here = list.filter((s) => {
    try {
      return new File(s.uri).exists;
    } catch {
      return false;
    }
  });
  if (here.length !== list.length) setList(here);
}

let cleaning = false;
/** Ask the Mac which conversations are gone, and delete what was saved from them. */
export async function cleanUp(): Promise<number> {
  if (cleaning || !cleanupOn() || !store.supports('gone') || !store.linked) return 0;
  const topics = topicsOf(list);
  if (!topics.length) return 0;
  cleaning = true;
  try {
    const r = await store.call<{ gone: string[] }>(calls.gone(topics), { queue: false });
    const { drop } = split(list, r?.gone ?? []);
    if (!drop.length) return 0;
    removeSaved(drop);
    store.toast({ text: `Removed ${drop.length === 1 ? 'a saved file' : `${drop.length} saved files`} from conversations archived on your Mac`, tone: 'info' });
    return drop.length;
  } catch {
    return 0;
  } finally {
    cleaning = false;
  }
}

// ---- the cache

/** What the cache takes now (full pictures, copies on their way). */
export const cacheSize = (): number => cacheBytes();

/** Empty the cache (and the image view's own): pictures come again from the Mac when next shown. */
export async function clearCache(): Promise<void> {
  clearCacheDirs();
  store.forgetPictures();
  await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]).catch(() => undefined);
}

let started = false;
/** At launch: nothing in the cache is used again, and each time the link opens, clean up. */
export function startSaved(): void {
  if (started) return;
  started = true;
  clearCacheDirs();
  store.subscribe('linked', () => void cleanUp());
}
