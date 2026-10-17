import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { peerName } from '../../core/store.js';
import { peopleRows } from '../banner.js';
import { fileWindow } from '../layout.js';
import { formatSize } from '../text.js';
import { glyph, theme } from '../theme.js';
import { LineView } from './LineView.js';
import { Panel } from './Panel.js';

interface SidebarProps {
  readonly state: AppState;
  readonly width: number;
  readonly peopleHeight: number;
  readonly filesHeight: number;
  readonly focus: 'people' | 'files' | 'other';
  readonly peopleCursor: number;
  readonly frame: number;
}

export function Sidebar({ state, width, peopleHeight, filesHeight, focus, peopleCursor, frame }: SidebarProps) {
  const people = peopleRows(state, frame);
  const { browser } = state;
  const win = fileWindow(browser, filesHeight);
  const rows = browser.rows.slice(win.start, win.start + win.count);
  const where = browser.at ? `${peerName(state, browser.at.owner)}/${browser.at.share}${browser.at.path ? `/${browser.at.path}` : ''}` : 'Shared files';
  const peopleFocused = focus === 'people';
  const filesFocused = focus === 'files';

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="People" width={width} height={peopleHeight} focused={peopleFocused} right={peopleFocused ? '↵ actions' : 'click'}>
        {people.map((p, i) => {
          const selected = peopleFocused && i === peopleCursor;
          return (
            <Box key={p.peerId} flexDirection="column">
              <Text wrap="truncate" inverse={selected}>
                <Text color={p.color}>{glyph.dot} </Text>
                <Text bold>{p.name}</Text>
                {p.you ? <Text color={theme.muted}> (you)</Text> : null}
                {state.follow === p.peerId ? <Text color={theme.warn}> {glyph.eye} following</Text> : null}
              </Text>
              <Box paddingLeft={2}>
                <LineView line={p.agent} />
              </Box>
            </Box>
          );
        })}
      </Panel>
      <Panel title={where} width={width} height={filesHeight} focused={filesFocused} right={filesFocused ? '' : 'click'}>
        {browser.loading ? <Text color={theme.muted}>loading…</Text> : null}
        {browser.error ? (
          <Text color={theme.error} wrap="truncate">
            {browser.error}
          </Text>
        ) : null}
        {rows.length === 0 && !browser.loading ? <Text color={theme.muted}>Nobody is sharing files yet</Text> : null}
        {rows.map((row, i) => {
          const selected = win.start + i === browser.cursor;
          const icon = row.target === 'up' ? '↩' : row.dir ? glyph.folder : glyph.file;
          return (
            <Text key={`${row.label}-${i}`} wrap="truncate" inverse={selected && filesFocused} color={selected && !filesFocused ? theme.text : undefined}>
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
