import type { SVGProps } from 'react';

/**
 * One small icon set, drawn on a 16×16 grid with 1.5 strokes (in the spirit of SF Symbols):
 * every icon in the app comes from here, so they match.
 */
const PATHS = {
  chat: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z',
  folder: 'M2.5 4.5A1 1 0 0 1 3.5 3.5h3l1.5 1.5h4.5a1 1 0 0 1 1 1V11.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
  file: 'M4 2.5h5l3 3v8H4z M9 2.5v3h3',
  diff: 'M5 3v6 M2 6h6 M8.5 12.5h5.5 M11 2.5l-2 11',
  terminal: 'M2.5 3.5h11v9h-11z M4.5 6.5l2 1.5-2 1.5 M8 10h3',
  plus: 'M8 3.5v9 M3.5 8h9',
  more: 'M4 8h.01 M8 8h.01 M12 8h.01',
  chevronRight: 'M6 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  chevronUp: 'M4 10l4-4 4 4',
  sidebar: 'M2.5 3.5h11v9h-11z M6 3.5v9',
  inspector: 'M2.5 3.5h11v9h-11z M10 3.5v9',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M10.5 10.5l3 3',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 1.8v1.6 M8 12.6v1.6 M1.8 8h1.6 M12.6 8h1.6 M3.6 3.6l1.1 1.1 M11.3 11.3l1.1 1.1 M3.6 12.4l1.1-1.1 M11.3 4.7l1.1-1.1',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z M6.5 13.5a1.5 1.5 0 0 0 3 0',
  people: 'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5z M2 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5 M10.5 7a2 2 0 1 0 0-4 M12 9.6c1.3.4 2 1.6 2 3.1',
  person: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4',
  branch: 'M5 3v10 M5 10c0-3 6-2 6-5 M11 2.5v2.5 M5 13a1.25 1.25 0 1 0 0-.01 M5 3a1.25 1.25 0 1 0 0-.01 M11 5a1.25 1.25 0 1 0 0-.01',
  /** Claude in klaud: the logo's prompt and cursor, at the logo's proportions. */
  claude: 'M3 4.5L6.7 8 3 11.5 M9.15 10.8h3.9',
  /** The old name for Claude's mark (kept so every use shows the same one). */
  spark: 'M3 4.5L6.7 8 3 11.5 M9.15 10.8h3.9',
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4 4l8 8 M12 4l-8 8',
  alert: 'M8 2.5l6 10.5H2z M8 6.5v3 M8 11.3v.01',
  play: 'M5 3.5l7 4.5-7 4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  archive: 'M2.5 3.5h11v3h-11z M3.5 6.5v6h9v-6 M6.5 9h3',
  share: 'M8 2.5v8 M5 5.5l3-3 3 3 M3.5 8.5v4.5h9V8.5',
  link: 'M6.5 9.5l3-3 M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1 M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1',
  copy: 'M5.5 5.5h7v7h-7z M3.5 10.5v-7h7',
  send: 'M8 13V3.5 M4 7.5l4-4 4 4',
  pencil: 'M10.5 2.75l2.75 2.75-7.5 7.5H3v-2.75z M9 4.25l2.75 2.75',
  image: 'M2.5 3.5h11v9h-11z M2.5 10.5l3-2.75 3 2.5 2-1.5 3 2.25 M10.25 6.25h.01',
  clip: 'M10.5 5.5l-4.3 4.3a1.4 1.4 0 0 0 2 2l4.8-4.8a2.8 2.8 0 0 0-4-4L4.2 7.8a4.2 4.2 0 0 0 6 6l4-4',
  clock: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M8 5v3l2 1.5',
  lock: 'M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2',
  globe: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M2.5 8h11 M8 2.5c-2 2.2-2 8.8 0 11 M8 2.5c2 2.2 2 8.8 0 11',
  grid: 'M3 3h4v4H3z M9 3h4v4H9z M3 9h4v4H3z M9 9h4v4H9z',
  gauge: 'M2.5 11a5.5 5.5 0 1 1 11 0 M8 11l2.5-3.5',
  command: 'M6 6V4.5A1.5 1.5 0 1 0 4.5 6H11.5A1.5 1.5 0 1 0 10 4.5v7a1.5 1.5 0 1 0 1.5-1.5h-7A1.5 1.5 0 1 0 6 11.5V6z',
  inbox: 'M2.5 9l1.8-5.5h7.4L13.5 9v3.5h-11z M2.5 9H6l.8 1.5h2.4L10 9h3.5',
  eye: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  eyeOff: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z M2.5 2.5l11 11',
  download: 'M8 2.5v8 M5 7.5l3 3 3-3 M3.5 13h9',
  refresh: 'M12.5 6A5 5 0 0 0 3.6 5.5 M3.5 3v2.6h2.6 M3.5 10a5 5 0 0 0 8.9.5 M12.5 13v-2.6H9.9',
  up: 'M8 13V3.5 M4.5 7L8 3.5 11.5 7',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  forward: 'M6 3.5L10.5 8 6 12.5',
  pr: 'M4.5 3v10 M11.5 6.5V13 M11.5 6.5c0-2-1.5-3-3.5-3H7 M8.5 1.8L7 3.5l1.5 1.7 M4.5 3a1.2 1.2 0 1 0 0 .01 M4.5 13a1.2 1.2 0 1 0 0 .01 M11.5 13a1.2 1.2 0 1 0 0 .01',
  merge: 'M5 3v10 M5 6c0 3 6 2 6 5v2 M5 3a1.2 1.2 0 1 0 0 .01 M11 13a1.2 1.2 0 1 0 0 .01',
  hand: 'M5 8V4.2a1 1 0 0 1 2 0V7.5 M7 7V3.2a1 1 0 0 1 2 0V7.5 M9 7V4a1 1 0 0 1 2 0v5c0 2.5-1.5 4.5-4 4.5-1.7 0-2.6-.8-3.6-2.3L2.4 9a1 1 0 0 1 1.7-1L5 9',
  /** Earnings (Stripe): a coin. */
  coin: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M9.7 6.3c-.3-.6-.9-.9-1.7-.9-.9 0-1.7.5-1.7 1.25 0 1.75 3.4 1 3.4 2.75 0 .75-.8 1.25-1.7 1.25-.8 0-1.4-.3-1.7-.9 M8 4.4v1 M8 10.6v1',
  wand: 'M3 13l7-7 M10 3.5v2 M12.5 6h-2 M12 4l-1.2 1.2 M8.5 2.5l.5 1 M13.5 7.5l-1 .5',
  pulse: 'M1.5 8.5h2.8l1.9-4.8 3.1 8.6 1.9-3.8h3.3',
  /** Open in full (the focus view): two corners pulled out. */
  expand: 'M9.5 2.5h4v4 M13.5 2.5L9 7 M6.5 13.5h-4v-4 M2.5 13.5L7 9',
  /** Open outside klaud (in the file's own app): an arrow leaving a box. */
  external: 'M9 2.5h4.5V7 M13.5 2.5L7.5 8.5 M11.5 9.5v4h-9v-9h4',
  /** The window with its bottom drawer (the terminal under the chat). */
  panelBottom: 'M2.5 3.5h11v9h-11z M2.5 9.5h11',
  /** The window with its right panel. */
  panelRight: 'M2.5 3.5h11v9h-11z M9.5 3.5v9',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
