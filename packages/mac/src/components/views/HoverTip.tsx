import { type ReactNode, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import v from './views.module.css';

/**
 * One tooltip for many small marks (a gantt's bars, a heatmap's cells, a calendar's days): it
 * follows whichever is hovered, above it, in the window's tooltip look. One per view rather than
 * one per mark, so a year of days stays light.
 */

type At = { readonly x: number; readonly y: number; readonly below: boolean; readonly body: ReactNode };

export function useHoverTip(): { show: (el: Element, body: ReactNode) => void; hide: () => void; tip: ReactNode } {
  const [at, setAt] = useState<At | undefined>();
  const show = useCallback((el: Element, body: ReactNode) => {
    const r = el.getBoundingClientRect();
    const below = r.top < 90;
    setAt({ x: r.left + r.width / 2, y: below ? r.bottom : r.top, below, body });
  }, []);
  const hide = useCallback(() => setAt(undefined), []);
  const tip = at
    ? createPortal(
        <div className={v.hoverTip} style={{ left: at.x, top: at.y, transform: at.below ? 'translate(-50%, 8px)' : 'translate(-50%, calc(-100% - 8px))' }} role="tooltip">
          {at.body}
        </div>,
        document.body,
      )
    : null;
  return { show, hide, tip };
}
