import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon.js';
import { inApp } from '../lib/boot.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import { type Box, MAX_DROPPED, dropHits, droppedFiles, sameBox } from './drop-model.js';
import { keepPreview, previewOf } from './images.js';
import { type ImageInText, type PathInfo, insertText, usePastePaths } from './paste-paths.js';
import s from './composer.module.css';
import img from './images.module.css';

/**
 * What goes with a message besides its words, the same in every message box (a conversation's
 * and a plan's): images pasted, dropped, or named by their path in pasted text wait as thumbnails,
 * with an "[image N]" in the words where they go; other files whose paths were pasted wait as
 * chips. Kept per conversation, so switching away and back keeps them.
 *
 * Files dragged from Finder anywhere on the conversation (the element marked `data-drop-zone`
 * around the box) go in the same way: the app takes the drop and hands over their paths.
 */

/** Images waiting to be sent, per conversation. */
const waitingImages = new Map<string, readonly number[]>();
/** Other files (their paths were pasted) waiting to go with the message, per conversation. */
const waitingFiles = new Map<string, readonly PathInfo[]>();
/** How the words refer to a waiting image (it becomes a link to it when sent). */
export const imageRef = (n: number): string => `[image ${n}]`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const imagesOf = (items: DataTransferItemList | undefined): File[] =>
  [...(items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));

export interface Attachments {
  readonly images: readonly number[];
  readonly files: readonly PathInfo[];
  /** Something is being dragged over the box (or, from Finder, over the conversation). */
  readonly dropping: boolean;
  /** Over the conversation while files from Finder are dragged on it: where they'll go. */
  readonly dropTarget: React.ReactNode;
  /** For the box around the words: drop images on it. */
  readonly dropProps: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  /** For the text field. */
  readonly onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Add image files (a paste, a drop). */
  readonly attach: (files: readonly File[]) => Promise<void>;
  /**
   * The message to send for what was typed: its images where their references are (those whose
   * reference was taken out go after it) and other files' paths. They leave the box; `putBack`
   * returns them if sending fails. Commands ("/…") go as typed, and attachments stay.
   */
  readonly take: (typed: string) => { readonly text: string; readonly putBack: () => void };
  /** The thumbnails and file chips, for above the words. */
  readonly waiting: React.ReactNode;
}

/**
 * `text`/`setText`: the words in the box (the composer keeps them in the window's UI state, the
 * plan chat in its own).
 */
export function useAttachments({ channel, box, text, setText }: { channel: string; box: RefObject<HTMLTextAreaElement | null>; text: () => string; setText: (text: string, cursor: number) => void }): Attachments {
  const { client } = useBeluga();
  const api = useApi();
  const selfId = client.store.getState().selfId;
  const [images, setImagesState] = useState<readonly number[]>(() => waitingImages.get(channel) ?? []);
  useEffect(() => setImagesState(waitingImages.get(channel) ?? []), [channel]);
  const setImages = (next: readonly number[]): void => {
    waitingImages.set(channel, next);
    setImagesState(next);
  };
  const pendingImages = images.filter((n) => previewOf(n));
  const [files, setFilesState] = useState<readonly PathInfo[]>(() => waitingFiles.get(channel) ?? []);
  useEffect(() => setFilesState(waitingFiles.get(channel) ?? []), [channel]);
  const setFiles = (next: readonly PathInfo[]): void => {
    if (next.length) waitingFiles.set(channel, next);
    else waitingFiles.delete(channel);
    setFilesState(next);
  };
  const [dropping, setDropping] = useState(false);

  /** "[image N]" goes in the words where the cursor is (or `where`), so you can say what it shows. → where the cursor is after it. */
  const placeRef = (n: number, where?: number): number => {
    const now = text();
    const el = box.current;
    const at = Math.min(where ?? (el && document.activeElement === el ? el.selectionStart : now.length), now.length);
    const before = now.slice(0, at);
    const after = now.slice(at);
    const chip = `${before && !/\s$/.test(before) ? ' ' : ''}${imageRef(n)}${after && !/^\s/.test(after) ? ' ' : after ? '' : ' '}`;
    setText(before + chip + after, before.length + chip.length);
    requestAnimationFrame(() => el?.setSelectionRange(before.length + chip.length, before.length + chip.length));
    return before.length + chip.length;
  };

  const attach = async (picked: readonly File[]): Promise<void> => {
    for (const file of picked) {
      const ext = (/image\/(png|jpe?g|gif|webp)/.exec(file.type)?.[1] ?? 'png') as 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp';
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      let added: { n: number; chip: string };
      try {
        added = await api.attachments.add(ext, btoa(bin));
        keepPreview(added.n, file);
      } catch (err) {
        toast(client, `Couldn't add ${file.name || 'the image'}: ${errorText(err)}`, 'error');
        continue;
      }
      setImages([...(waitingImages.get(channel) ?? []), added.n]);
      placeRef(added.n);
    }
  };

  /** An image file on this Mac, waiting to go: its number (undefined when it couldn't be added, said in a toast). */
  const addImageFile = async (f: PathInfo): Promise<number | undefined> => {
    try {
      const added = await api.attachments.addFile(f.path);
      const shown = await api.attachments.read(selfId, added.file);
      keepPreview(added.n, new Blob([Uint8Array.from(atob(shown.data), (c) => c.charCodeAt(0))], { type: shown.mime }));
      setImages([...(waitingImages.get(channel) ?? []), added.n]);
      return added.n;
    } catch (err) {
      toast(client, `Couldn't add ${f.name}: ${errorText(err)}`, 'error');
      return undefined;
    }
  };

  /** Files on this Mac: images wait as thumbnails (referenced at `at`, else where the cursor is), others as chips. */
  const addPaths = async (picked: readonly PathInfo[], at?: number): Promise<void> => {
    const others = picked.filter((f) => !f.image);
    if (others.length) setFiles([...(waitingFiles.get(channel) ?? []), ...others.filter((f) => !(waitingFiles.get(channel) ?? []).some((w) => w.path === f.path))]);
    let cursor = at;
    for (const f of picked.filter((x) => x.image)) {
      const n = await addImageFile(f);
      if (n !== undefined) cursor = placeRef(n, cursor);
    }
  };

  /** Paths dropped from Finder: the files among them go as a paste of their paths would. */
  const dropPaths = async (paths: readonly string[]): Promise<void> => {
    let infos: readonly PathInfo[];
    try {
      infos = await api.local.statFiles(paths.slice(0, MAX_DROPPED));
    } catch (err) {
      return toast(client, `Couldn't add what you dropped: ${errorText(err)}`, 'error');
    }
    const { files: picked, skipped } = droppedFiles(infos);
    if (skipped) toast(client, picked.length ? `Only files go with a message: ${skipped} left out` : 'Only files go with a message (not folders)', 'warn');
    if (!picked.length) return;
    await addPaths(picked);
    box.current?.focus();
  };
  const latestDrop = useRef(dropPaths);
  latestDrop.current = dropPaths;

  // Finder drops: the app takes them (the page never sees the files), so listen to it. Each box
  // answers for its own conversation only, and not while it can't be written in.
  const [dragOver, setDragOver] = useState<Box>();
  useEffect(() => {
    if (!inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    const zoneAt = (x: number, y: number): Box | undefined => {
      const el = box.current;
      if (!el || el.disabled || el.readOnly) return undefined;
      const r = (el.closest('[data-drop-zone]') ?? el.parentElement)?.getBoundingClientRect();
      const at = r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : undefined;
      return dropHits(at, x, y, window.devicePixelRatio || 1) ? at : undefined;
    };
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'leave') return setDragOver(undefined);
        const here = zoneAt(p.position.x, p.position.y);
        if (p.type === 'drop') {
          setDragOver(undefined);
          if (here && p.paths.length) void latestDrop.current(p.paths);
        } else setDragOver((was) => (sameBox(was, here) ? was : here));
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
      setDragOver(undefined);
    };
  }, [channel]);

  const pastePaths = usePastePaths(
    box,
    // Only paths of files on this Mac: images wait as thumbnails (referenced where the cursor was), others as chips.
    (picked, at) => void addPaths(picked, at),
    // Words naming images: the words go in, each image's path (quotes and all) becomes its reference.
    async (pasted: string, found: readonly ImageInText[], at) => {
      let words = '';
      let from = 0;
      for (const hit of found) {
        const n = await addImageFile(hit.info);
        words += pasted.slice(from, hit.start) + (n === undefined ? pasted.slice(hit.start, hit.end) : imageRef(n));
        from = hit.end;
      }
      words += pasted.slice(from);
      if (box.current) insertText(box.current, words, at);
    },
  );

  const removeImage = (n: number): void => {
    setImages(images.filter((x) => x !== n));
    const now = text();
    if (now.includes(imageRef(n))) {
      const next = now.replace(` ${imageRef(n)}`, '').replace(imageRef(n), '');
      setText(next, next.length);
    }
    box.current?.focus();
  };

  const take = (typed: string): { text: string; putBack: () => void } => {
    if (typed.startsWith('/')) return { text: typed, putBack: () => undefined };
    const pictures = pendingImages;
    const unplaced = pictures.filter((n) => !typed.includes(imageRef(n)));
    // Other files go as their paths (Claude reads them from this Mac).
    const others = files;
    const out = pictures.length || others.length ? [typed, unplaced.map(imageRef).join(' '), others.map((f) => `\`${f.path}\``).join('\n')].filter(Boolean).join('\n\n') : typed;
    if (pictures.length) setImages([]);
    if (others.length) setFiles([]);
    return {
      text: out,
      putBack: () => {
        if (pictures.length) setImages(pictures);
        if (others.length) setFiles(others);
      },
    };
  };

  const waiting = (
    <>
      {pendingImages.length ? (
        <div className={img.pending} role="group" aria-label="Images to send">
          {pendingImages.map((n) => (
            <div key={n} className={img.pendingItem}>
              <img src={previewOf(n)} alt={`image ${n}`} />
              <span className={img.pendingLabel}>{n}</span>
              <button type="button" className={img.pendingRemove} aria-label={`Remove image ${n}`} onClick={() => removeImage(n)}>
                <Icon name="x" size={9} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className={s.fileChips} role="list" aria-label="Files to send">
          {files.map((f) => (
            <span key={f.path} role="listitem" className={s.fileChip} title={f.path}>
              <Icon name="file" size={11} />
              <span className={s.fileName}>{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.path !== f.path))}>
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );

  const dropTarget = dragOver
    ? createPortal(
        <div className={s.dropTarget} style={{ left: dragOver.left, top: dragOver.top, width: dragOver.right - dragOver.left, height: dragOver.bottom - dragOver.top }} aria-hidden>
          <div className={s.dropTargetLabel}>
            <Icon name="image" size={16} />
            Drop to attach
          </div>
        </div>,
        document.body,
      )
    : null;

  return {
    images: pendingImages,
    files,
    dropping: dropping || Boolean(dragOver),
    dropTarget,
    dropProps: {
      onDragOver: (e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
          setDropping(true);
        }
      },
      onDragLeave: () => setDropping(false),
      onDrop: (e) => {
        const dropped = imagesOf(e.dataTransfer.items);
        setDropping(false);
        if (!dropped.length) return;
        e.preventDefault();
        void attach(dropped);
      },
    },
    onPaste: (e) => {
      const pasted = imagesOf(e.clipboardData.items);
      if (!pasted.length) return void pastePaths(e);
      e.preventDefault();
      void attach(pasted);
    },
    attach,
    take,
    waiting,
  };
}
