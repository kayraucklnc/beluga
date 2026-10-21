import { useEffect, useRef } from 'react';
import { useOnViewportChange, useStoreApi } from '@xyflow/react';

/** How long the view must sit still before it's redrawn sharp. */
export const SETTLE_MS = 120;
const NUDGE = ' translateZ(0)';

/**
 * Text stays sharp at every zoom (KLD-25). React Flow zooms with `transform: scale()` on `.react-flow__viewport`.
 * In WKWebView, once that layer is composited (anything inside it animating transform or opacity), it keeps the
 * bitmap it was rasterized at and zooming past it just stretches the pixels. So once a zoom or pan settles,
 * nudge the layer: for two frames it gets `translateZ(0)` and then loses it, which makes WebKit rebuild its
 * backing at the current scale. Chromium re-rasterizes on its own; there the nudge is harmless.
 *
 * Call inside a ReactFlowProvider. Keep blur (filter, backdrop-filter) off anything inside the viewport.
 */
export function useSharpZoom(): void {
  const store = useStoreApi();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = store.getState().domNode?.querySelector<HTMLElement>('.react-flow__viewport');
      if (el) sharpen(el);
    }, SETTLE_MS);
  };
  useOnViewportChange({ onChange: settle, onEnd: settle });
  useEffect(() => () => clearTimeout(timer.current), []);
}

/** Re-rasterize a scaled layer at its current scale. */
export function sharpen(el: HTMLElement): void {
  if (!el.style.transform || el.style.transform.endsWith(NUDGE)) return;
  el.style.transform += NUDGE;
  el.dataset.sharpened = String(Date.now());
  // Two frames: the first commits the 3D layer, the second drops it. React Flow may have moved the view
  // meanwhile (its own transform then has no nudge), so only strip what we added.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (el.style.transform.endsWith(NUDGE)) el.style.transform = el.style.transform.slice(0, -NUDGE.length);
    }),
  );
}
