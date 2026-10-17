import React from 'react';
import { Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { peerName } from '../../core/store.js';
import { glyph, theme } from '../theme.js';
import { Panel } from './Panel.js';

interface ViewerProps {
  readonly state: AppState;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
}

export function Viewer({ state, width, height, focused }: ViewerProps) {
  const v = state.viewer;
  if (!v) return null;
  const inner = height - 2;
  const lines = v.content.split('\n');
  const gutter = String(lines.length).length;
  const shown = lines.slice(v.scroll, v.scroll + inner);
  const right = v.loading ? 'loading…' : v.by ? `${glyph.eye} ${v.by}` : `${glyph.dot} live`;
  return (
    <Panel
      title={`${peerName(state, v.owner)}/${v.share}/${v.path}`}
      right={right}
      rightColor={v.by ? theme.warn : theme.ok}
      width={width}
      height={height}
      focused={focused}
    >
      {v.error ? <Text color={theme.error}>{v.error}</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate">
          <Text color={theme.muted}>{String(v.scroll + i + 1).padStart(gutter)}  </Text>
          {line.replace(/\t/g, '  ') || ' '}
        </Text>
      ))}
      {v.truncated ? <Text color={theme.warn}>[file truncated at 512 KB]</Text> : null}
    </Panel>
  );
}
