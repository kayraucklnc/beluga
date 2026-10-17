import React from 'react';
import { Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { peerName } from '../../core/store.js';
import { fileWindow } from '../layout.js';
import { formatSize } from '../text.js';
import { glyph, theme } from '../theme.js';
import { Panel } from './Panel.js';

interface FilesPanelProps {
  readonly state: AppState;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly title?: string;
}

/** Browse a shared folder (friends' shares in the room, or a workspace's files). */
export function FilesPanel({ state, width, height, focused, title }: FilesPanelProps) {
  const { browser } = state;
  const win = fileWindow(browser, height);
  const rows = browser.rows.slice(win.start, win.start + win.count);
  const where = title ?? (browser.at ? `${peerName(state, browser.at.owner)}/${browser.at.share}${browser.at.path ? `/${browser.at.path}` : ''}` : 'Shared files');
  return (
    <Panel title={where} width={width} height={height} focused={focused} right={focused ? '↵ open  ← back  d download' : 'click a file'}>
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
          <Text key={`${row.label}-${i}`} wrap="truncate" inverse={selected && focused} color={selected && !focused ? theme.text : undefined}>
            <Text color={row.dir ? theme.info : theme.muted}>{icon} </Text>
            <Text bold={row.dir}>{row.target === 'up' ? 'back' : row.label}</Text>
            {row.size !== undefined && !row.dir ? <Text color={theme.muted}> {formatSize(row.size)}</Text> : null}
          </Text>
        );
      })}
    </Panel>
  );
}
