import { useEffect, useState, useSyncExternalStore } from 'react';
import type { LinkedImage } from '@klaud/shared/attachment-links.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';

/**
 * Images linked in chat messages, fetched once through the core (yours from disk, a friend's
 * through their share) and kept as object URLs for this window. Plus the one open lightbox.
 */

type Api = SocketClient['api'];

const cache = new Map<string, Promise<string>>();

function toBlobUrl(data: string, mime: string): string {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** The image as a URL this window can show (fetched on first use, then cached). */
export function loadImage(api: Api, image: Pick<LinkedImage, 'href' | 'owner' | 'file'>): Promise<string> {
  const hit = cache.get(image.href);
  if (hit) return hit;
  const load = api.attachments.read(image.owner, image.file).then((r) => toBlobUrl(r.data, r.mime));
  cache.set(image.href, load);
  // A failure isn't kept: the next time it shows, it tries again (the friend may be back).
  load.catch(() => cache.delete(image.href));
  return load;
}

export type ImageState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly url: string } | { readonly status: 'error'; readonly error: string };

export function useImage(api: Api, image: LinkedImage): ImageState {
  const [state, setState] = useState<ImageState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    loadImage(api, image).then(
      (url) => alive && setState({ status: 'ready', url }),
      (err: unknown) => alive && setState({ status: 'error', error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [api, image.href]);
  return state;
}

// ---- pictures of images pasted into the box, by chip number (kept while the draft is)

const pending = new Map<number, string>();

/** Remember what a pasted image looks like (its chip may outlive the box that took it). */
export function keepPreview(n: number, file: Blob): void {
  pending.set(n, URL.createObjectURL(file));
}

export const previewOf = (n: number): string | undefined => pending.get(n);

// ---- the lightbox: one per window, opened from any message

interface Lightbox {
  readonly images: readonly LinkedImage[];
  readonly index: number;
}

let open: Lightbox | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function openLightbox(images: readonly LinkedImage[], index = 0): void {
  open = { images, index: Math.max(0, Math.min(index, images.length - 1)) };
  emit();
}

export function closeLightbox(): void {
  open = undefined;
  emit();
}

/** Show the next (1) or previous (-1) image of the same message. */
export function stepLightbox(delta: number): void {
  if (!open || open.images.length < 2) return;
  open = { ...open, index: (open.index + delta + open.images.length) % open.images.length };
  emit();
}

export function useLightbox(): Lightbox | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => open,
  );
}

/** Put the image on the clipboard (as PNG, which every app pastes). */
export async function copyImage(url: string): Promise<void> {
  const blob = await (await fetch(url)).blob();
  const png =
    blob.type === 'image/png'
      ? blob
      : await new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d')?.drawImage(img, 0, 0);
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert the image"))), 'image/png');
          };
          img.onerror = () => reject(new Error("Couldn't read the image"));
          img.src = url;
        });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
