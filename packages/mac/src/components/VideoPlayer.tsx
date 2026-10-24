import { type ReactNode, useEffect, useState } from 'react';
import { Empty, EmptyActions } from './ui.js';
import v from './video-player.module.css';

/**
 * A video, inline (BLG-100): the web view's own player (play, pause, seek, volume, full screen),
 * never autoplaying or looping. MP4, M4V and MOV (H.264, HEVC) and WebM (VP8, VP9) play; what the
 * web view can't decode (ProRes, say) says so, with the way out the place showing it offers.
 */
export function VideoPlayer({ url, name, fallback }: { readonly url: string; readonly name: string; readonly fallback?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed) return <Empty icon="play" title="Can’t play this video here" detail="Its format or codec isn’t one the app plays. Open it with its app." action={fallback ? <EmptyActions>{fallback}</EmptyActions> : undefined} />;
  return (
    <div className={v.wrap}>
      <video className={v.video} src={url} controls playsInline preload="metadata" aria-label={name} onError={() => setFailed(true)} />
    </div>
  );
}

/** An object URL for base64 bytes (let go when they change or the screen goes). */
export function useBlobUrl(data: string | undefined, mime: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!data || !mime) return setUrl(undefined);
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const made = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [data, mime]);
  return url;
}

