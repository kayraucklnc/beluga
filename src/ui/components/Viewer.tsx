import React from 'react';
import { Box, Text } from 'ink';
import type { AppState, ViewerState } from '../../core/store.js';
import { peerName } from '../../core/store.js';
import { isMarkdownPath } from '../markdown.js';
import { isImagePath } from '../../image/decode.js';
import { type Bitmap } from '../../image/bitmap.js';
import { imageToLines } from '../../image/render.js';
import { renderMarkdownAnsi } from '../markdown-render.js';
import { ansiToLine } from '../ansi.js';
import { type Line, plain } from '../text.js';
import { glyph, theme } from '../theme.js';
import { LineView } from './LineView.js';
import { Panel } from './Panel.js';

interface ViewerProps {
  readonly state: AppState;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly raw: boolean;
  readonly full: boolean;
}

/** Clickable controls drawn on the viewer's last line. Shared with mouse hit-testing. */
export function viewerLegend(v: ViewerState, full: boolean, raw: boolean): Array<{ id: string; label: string }> {
  return [
    { id: 'fullscreen', label: full ? 'Exit fullscreen f' : 'Fullscreen f' },
    ...(isMarkdownPath(v.path) ? [{ id: 'raw', label: raw ? 'Rendered r' : 'Source r' }] : []),
    ...(isImagePath(v.path) ? [{ id: 'raw', label: raw ? 'Color r' : 'Text art r' }] : []),
    { id: 'download', label: '↓ Download d' },
    { id: 'close', label: '✕ Close ⌫' },
  ];
}
export const LEGEND_GAP = 3;

// Downsampling is the slow part, so keep the last render per image (re-renders happen every frame).
const imageCache = new WeakMap<Bitmap, { key: string; lines: Line[] }>();

function imageLines(image: Bitmap, cols: number, rows: number, ascii: boolean): Line[] {
  const key = `${cols}x${rows}:${ascii}`;
  const hit = imageCache.get(image);
  if (hit?.key === key) return hit.lines;
  const art = imageToLines(image, cols, rows, { mode: ascii ? 'ascii' : 'blocks', upscale: true });
  const pad = Math.max(0, Math.floor((cols - (art[0]?.reduce((n, s) => n + s.text.length, 0) ?? 0)) / 2));
  const lines = pad ? art.map((l) => [{ text: ' '.repeat(pad) }, ...l]) : art;
  imageCache.set(image, { key, lines });
  return lines;
}

/** Rows available for content inside a viewer of this height. */
export const viewerInner = (height: number): number => height - 3;

/** All lines the viewer can show (image, rendered Markdown or numbered source). Exported for scroll bounds. */
export function viewerLines(v: ViewerState, width: number, raw: boolean, height = 0): Line[] {
  if (v.image) return imageLines(v.image, Math.max(1, width - 4), Math.max(1, viewerInner(height)), raw);
  if (isMarkdownPath(v.path) && !raw) return renderMarkdownAnsi(v.content, width - 6).map(ansiToLine);
  const lines = v.content.split('\n');
  const gutter = String(lines.length).length;
  return lines.map((line, i) => [
    { text: `${String(i + 1).padStart(gutter)}  `, color: theme.muted },
    { text: line.replace(/\t/g, '  ') },
  ]);
}

export function Viewer({ state, width, height, focused, raw, full }: ViewerProps) {
  const v = state.viewer;
  if (!v || width <= 0) return null;
  const inner = viewerInner(height);
  const lines = viewerLines(v, width, raw, height);
  const scroll = Math.min(v.scroll, Math.max(0, lines.length - inner));
  const shown = lines.slice(scroll, scroll + inner);
  const mode = v.image ? `${v.image.width}×${v.image.height}` : isMarkdownPath(v.path) ? (raw ? 'raw' : 'rendered') : '';
  const status = v.loading ? 'loading…' : v.by ? `${glyph.eye} ${v.by}` : `${glyph.dot} live`;
  return (
    <Panel
      title={`${peerName(state, v.owner)}/${v.share}/${v.path}`}
      right={[mode, status].filter(Boolean).join(' · ')}
      rightColor={v.by ? theme.warn : theme.ok}
      width={width}
      height={height}
      focused={focused}
    >
      {v.error ? <Text color={theme.error}>{v.error}</Text> : null}
      {shown.map((line, i) => (
        <LineView key={i} line={line.length ? line : plain(' ')} />
      ))}
      {v.truncated ? <Text color={theme.warn}>[file truncated at 512 KB — download it to see everything]</Text> : null}
      <Box flexGrow={1} />
      <Text wrap="truncate">
        {viewerLegend(v, full, raw).map((b, i) => (
          <Text key={b.id} color={focused ? theme.text : theme.muted}>
            {i > 0 ? ' '.repeat(LEGEND_GAP) : ''}
            {b.label}
          </Text>
        ))}
        {scroll + inner < lines.length ? <Text color={theme.muted}>{'   '}↓ more</Text> : null}
      </Text>
    </Panel>
  );
}
