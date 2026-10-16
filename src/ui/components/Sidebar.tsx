import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { peerName } from '../../core/store.js';
import { peopleRows } from '../banner.js';
import { formatSize } from '../text.js';
import { glyph, theme } from '../theme.js';
import { LineView } from './LineView.js';
import { Panel } from './Panel.js';

interface SidebarProps {
  readonly state: AppState;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly frame: number;
}

export function Sidebar({ state, width, height, focused, frame }: SidebarProps) {
  const people = peopleRows(state, frame);
  const peopleHeight = Math.min(people.length * 2 + 3, Math.floor(height / 2));
  const filesHeight = height - peopleHeight;
  const { browser } = state;
  const rowsAvail = Math.max(1, filesHeight - 3 - (browser.error ? 1 : 0));
  const start = Math.max(0, Math.min(browser.cursor - Math.floor(rowsAvail / 2), browser.rows.length - rowsAvail));
  const rows = browser.rows.slice(start, start + rowsAvail);
  const where = browser.at ? `${peerName(state, browser.at.owner)}/${browser.at.share}${browser.at.path ? `/${browser.at.path}` : ''}` : 'Shared files';

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="People" width={width} height={peopleHeight}>
        {people.map((p) => (
          <Box key={p.peerId} flexDirection="column">
            <Text wrap="truncate">
              <Text color={p.color}>{glyph.dot} </Text>
              <Text bold>{p.name}</Text>
              {p.you ? <Text color={theme.muted}> (you)</Text> : null}
              {state.follow === p.peerId ? <Text color={theme.warn}> {glyph.eye}</Text> : null}
            </Text>
            <Box paddingLeft={2}>
              <LineView line={p.agent} />
            </Box>
          </Box>
        ))}
      </Panel>
      <Panel title={where} width={width} height={filesHeight} focused={focused} right={focused ? '↵ open  ← back' : 'Tab'}>
        {browser.loading ? <Text color={theme.muted}>loading…</Text> : null}
        {browser.error ? (
          <Text color={theme.error} wrap="truncate">
            {browser.error}
          </Text>
        ) : null}
        {rows.length === 0 && !browser.loading ? <Text color={theme.muted}>Nobody is sharing files yet</Text> : null}
        {rows.map((row, i) => {
          const selected = start + i === browser.cursor;
          const icon = row.target === 'up' ? '↩' : row.dir ? glyph.folder : glyph.file;
          return (
            <Text key={`${row.label}-${i}`} wrap="truncate" inverse={selected && focused} color={selected && !focused ? theme.focus : undefined}>
              <Text color={row.dir ? theme.info : theme.muted}>{icon} </Text>
              <Text bold={row.dir}>{row.target === 'up' ? 'back' : row.label}</Text>
              {row.size !== undefined && !row.dir ? <Text color={theme.muted}> {formatSize(row.size)}</Text> : null}
            </Text>
          );
        })}
      </Panel>
    </Box>
  );
}
