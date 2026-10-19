import { useEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui.js';
import s from './panel.module.css';

export interface ResizeHandleProps {
  /** 'x': drag left and right (the panel's edge); 'y': up and down (the drawer, a split). */
  readonly axis: 'x' | 'y';
  readonly label: string;
  /** The pointer's position on the axis (clientX or clientY) while dragging. */
  readonly onMove: (pos: number) => void;
  /** The drag ended (save the size now, not on every move). */
  readonly onEnd?: () => void;
  /** Double-click: back to the default size. */
  readonly onReset?: () => void;
  /** Arrow keys (when the handle has keyboard focus): grow (+1) or shrink (-1) a step. */
  readonly onStep?: (dir: 1 | -1) => void;
  readonly className?: string;
}

/**
 * The thin line between two areas that you drag to resize (like NSSplitView's divider): a few
 * pixels wider than it looks, highlighted while hovered or dragged, and usable from the keyboard.
 */
export function ResizeHandle({ axis, label, onMove, onEnd, onReset, onStep, className }: ResizeHandleProps) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.resizing;
    },
    [],
  );
  const end = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    delete document.documentElement.dataset.resizing;
    onEnd?.();
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      className={cx(s.handle, axis === 'x' ? s.handleX : s.handleY, active && s.handleActive, className)}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        setActive(true);
        // The whole window shows the resize cursor and nothing gets selected while dragging.
        document.documentElement.dataset.resizing = axis;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) onMove(axis === 'x' ? e.clientX : e.clientY);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (!onStep) return;
        const grow = axis === 'x' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
        const shrink = axis === 'x' ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
        if (!grow && !shrink) return;
        e.preventDefault();
        onStep(grow ? 1 : -1);
      }}
    />
  );
}

/**
 * Keep something on screen while it animates away: `mounted` stays true for `ms` after `open`
 * turns false (so it can slide out), then it's removed.
 */
export function usePresence(open: boolean, ms: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    const reduce = document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return setMounted(false);
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/** The window's width, kept up to date. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return width;
}
