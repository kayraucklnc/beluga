import { useEffect, useState, useSyncExternalStore } from 'react';
import { useProjectIcon } from '../lib/projects.js';

/**
 * A project's tint on the board (BLG-300): its tiles carry a soft wash of the project's own colour,
 * taken from its icon (the most colourful pixels), or from the hue its letter tile uses. You can
 * pick another from named pastels, or none; the pick is per project and kept on this Mac.
 */

export const TINTS = [
  { id: 'blue', label: 'Blue', color: '#5b8def' },
  { id: 'teal', label: 'Teal', color: '#3aa3a0' },
  { id: 'mint', label: 'Mint', color: '#3fae7c' },
  { id: 'sand', label: 'Sand', color: '#c9a25a' },
  { id: 'peach', label: 'Peach', color: '#e8915a' },
  { id: 'rose', label: 'Rose', color: '#df6f86' },
  { id: 'lilac', label: 'Lilac', color: '#9a7ad8' },
  { id: 'slate', label: 'Slate', color: '#7a8597' },
] as const;

/** 'auto' (from its icon), 'none', or one of TINTS. */
export type TintChoice = 'auto' | 'none' | (typeof TINTS)[number]['id'];

const KEY = 'sentinel.tint.';
const listeners = new Set<() => void>();
let version = 0;

export function tintChoiceOf(projectId: string): TintChoice {
  try {
    const v = localStorage.getItem(KEY + projectId);
    return v === 'none' || TINTS.some((t) => t.id === v) ? (v as TintChoice) : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTintChoice(projectId: string, choice: TintChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY + projectId);
    else localStorage.setItem(KEY + projectId, choice);
  } catch {
    // Not kept: it still shows now.
  }
  version++;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The same calm hue a project's letter tile has (ProjectIcon's). */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** An icon's colour, worked out once per picture: the average of its most colourful pixels. */
const sampled = new Map<string, Promise<string | undefined>>();
function colorOf(src: string): Promise<string | undefined> {
  const known = sampled.get(src);
  if (known) return known;
  const p = new Promise<string | undefined>((done) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return done(undefined);
        g.drawImage(img, 0, 0, 24, 24);
        const px = g.getImageData(0, 0, 24, 24).data;
        let r = 0;
        let gr = 0;
        let b = 0;
        let w = 0;
        for (let i = 0; i < px.length; i += 4) {
          const [pr, pg, pb, pa] = [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
          if (pa < 128) continue;
          const max = Math.max(pr, pg, pb);
          const min = Math.min(pr, pg, pb);
          const sat = max === 0 ? 0 : (max - min) / max;
          // Greys, whites and near-blacks say little about an icon's colour.
          if (sat < 0.25 || max < 50) continue;
          const weight = sat * sat;
          r += pr * weight;
          gr += pg * weight;
          b += pb * weight;
          w += weight;
        }
        done(w > 0 ? `rgb(${Math.round(r / w)}, ${Math.round(gr / w)}, ${Math.round(b / w)})` : undefined);
      } catch {
        done(undefined);
      }
    };
    img.onerror = () => done(undefined);
    img.src = src;
  });
  sampled.set(src, p);
  return p;
}

/** A project's tint as a CSS colour (none: no tint). Your Mac's tiles have none. */
export function useProjectTint(projectId: string | undefined, name: string): string | undefined {
  useSyncExternalStore(subscribe, () => version);
  const icon = useProjectIcon(projectId ?? '');
  const [fromIcon, setFromIcon] = useState<string>();
  useEffect(() => {
    let alive = true;
    if (icon) void colorOf(icon).then((c) => alive && setFromIcon(c));
    else setFromIcon(undefined);
    return () => {
      alive = false;
    };
  }, [icon]);
  if (!projectId) return undefined;
  const choice = tintChoiceOf(projectId);
  if (choice === 'none') return undefined;
  if (choice !== 'auto') return TINTS.find((t) => t.id === choice)!.color;
  return fromIcon ?? `hsl(${hue(name)} 55% 55%)`;
}
