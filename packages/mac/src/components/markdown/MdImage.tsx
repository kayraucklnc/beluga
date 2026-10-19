import { useEffect, useRef, useState } from 'react';
import type { Location } from '@klaud/core/store.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { Icon } from '../Icon.js';
import { useKlaud } from '../../lib/klaud.js';
import { resolveImage } from './md-paths.js';
import m from './markdown.module.css';

/**
 * Images in a document. Next to the file (`![](assets/flow.svg)`): read through klaud, with the
 * same rules as opening the file. On the web: only over https. Anything else shows its alt text.
 */

const urls = new Map<string, Promise<string>>();
const KEEP = 64;

const keyOf = (at: Location, version?: string | number): string => `${at.owner}\0${at.share}\0${at.path}${version === undefined ? '' : `\0${version}`}`;

/** An object URL for an image file, read once and kept for a while (the oldest are let go); a new `version` reads it again. */
export function imageUrl(client: SocketClient, at: Location, version?: string | number): Promise<string> {
  const key = keyOf(at, version);
  const hit = urls.get(key);
  if (hit) return hit;
  const p = client.api.files.readImageFile(at).then(({ mediaType, data }) => {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  });
  urls.set(key, p);
  // A failed read is tried again next time.
  p.catch(() => urls.delete(key));
  if (urls.size > KEEP) {
    const [oldest, url] = urls.entries().next().value!;
    urls.delete(oldest);
    void url.then(URL.revokeObjectURL, () => undefined);
  }
  return p;
}

/** The object URL of an image file once it's read (undefined meanwhile), or the error. */
export function useImageUrl(at: Location | undefined, version?: string | number): { url?: string; error?: string } {
  const { client } = useKlaud();
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>();
  const key = at ? keyOf(at, version) : '';
  // While a newer version loads, the last picture stays (no flash).
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!at) return;
    let alive = true;
    imageUrl(client, at, version).then(
      (url) => alive && setState({ key, url }),
      (err: unknown) => alive && setState({ key, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  if (state?.key === key && state.url) last.current = state.url;
  if (state?.key === key) return { ...(state.url ? { url: state.url } : {}), ...(state.error ? { error: state.error } : {}) };
  return version !== undefined && last.current ? { url: last.current } : {};
}

function Missing({ alt, why }: { alt: string; why: string }) {
  return (
    <span className={m.imageMissing} title={why}>
      <Icon name="image" size={12} />
      {alt || 'Image'}
    </span>
  );
}

export function MdImage({ src, alt = '', title, doc }: { src: string; alt?: string; title?: string; doc: Location }) {
  const target = resolveImage(src, doc.path);
  const local = target.kind === 'local' ? { ...doc, path: target.path } : undefined;
  const { url, error } = useImageUrl(local);
  if (target.kind === 'remote') return <img className={m.image} src={target.url} alt={alt} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
  if (target.kind === 'blocked') return <Missing alt={alt} why="Only images next to this file, or on the web over https, are shown" />;
  if (error) return <Missing alt={alt} why={`Can’t show ${target.path}: ${error}`} />;
  if (!url) return <span className={m.imageLoading} role="img" aria-label={alt || 'Loading image'} />;
  return <img className={m.image} src={url} alt={alt} title={title ?? target.path} decoding="async" />;
}
