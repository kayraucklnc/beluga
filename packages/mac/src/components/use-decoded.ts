import { useEffect, useState } from 'react';

/**
 * A picture's URL once it's decoded, with its size. A newer URL (the file was written again) is
 * decoded off to the side first: the one on screen stays until the new one is ready, so a live
 * screenshot never blanks, flashes or stutters while you look at it (or zoom it).
 */

export interface Decoded {
  readonly url: string;
  readonly w: number;
  readonly h: number;
}

export function useDecoded(url: string | undefined): Decoded | undefined {
  const [shown, setShown] = useState<Decoded>();
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.decoding = 'async';
    // Loaded, then decoded (decode() rejects for some SVGs, and a picture that won't load at all
    // is still shown, as the broken image it is, rather than the last one forever).
    const show = (): void => {
      if (alive) setShown({ url, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onload = () => void (typeof img.decode === 'function' ? img.decode().then(show, show) : show());
    img.onerror = show;
    img.src = url;
    return () => {
      img.onload = null;
      img.onerror = null;
      alive = false;
    };
  }, [url]);
  return url ? shown : undefined;
}
