import React from 'react';
import { Box, Text } from 'ink';
import type { AppState, Approval } from '../core/store.js';
import { peerName } from '../core/store.js';
import { approvalLines, colorFor, formatSize, renderLog, windowLines } from './format.js';
import type { Mode, Pane } from './keymap.js';

const border = (active: boolean): string => (active ? 'cyan' : 'gray');

export function Header({ state }: { state: AppState }) {
  const dot = state.status === 'connected' ? 'green' : state.status === 'connecting' ? 'yellow' : 'red';
  return (
    <Box height={1} paddingX={1}>
      <Text bold color="magentaBright">klaude </Text>
      <Text color="gray">{state.room} </Text>
      <Text color={dot}>● {state.status} </Text>
      <Text color="gray">│ </Text>
      {state.peers.map((p) => (
        <Text key={p.peerId} color={colorFor(p.name)}>
          {p.peerId === state.self?.peerId ? '★' : '●'}
          {p.name}
          {p.agent ? <Text color="magenta">◆</Text> : null}{' '}
        </Text>
      ))}
      {state.follow ? <Text color="yellowBright">│ following {peerName(state, state.follow)}</Text> : null}
    </Box>
  );
}

interface PaneProps {
  readonly state: AppState;
  readonly active: boolean;
  readonly width: number;
  readonly height: number;
}

export function FilesPane({ state, active, width, height }: PaneProps) {
  const { browser } = state;
  const inner = height - 3;
  const start = Math.max(0, Math.min(browser.cursor - Math.floor(inner / 2), browser.rows.length - inner));
  const rows = browser.rows.slice(start, start + inner);
  const title = browser.at ? `${peerName(state, browser.at.owner)}:${browser.at.share}/${browser.at.path}` : 'shared folders';
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={border(active)}>
      <Text bold color={active ? 'cyan' : 'white'} wrap="truncate-start">
        {' '}
        {title}
      </Text>
      {browser.loading ? <Text color="gray"> loading…</Text> : null}
      {browser.error ? <Text color="red" wrap="truncate"> {browser.error}</Text> : null}
      {rows.length === 0 && !browser.loading ? <Text color="gray"> nothing shared yet</Text> : null}
      {rows.map((row, i) => {
        const selected = start + i === browser.cursor;
        const size = row.size !== undefined && !row.dir ? ` ${formatSize(row.size)}` : '';
        return (
          <Text key={`${row.label}-${i}`} inverse={selected && active} color={row.dir ? 'blue' : undefined} wrap="truncate">
            {selected ? '›' : ' '}
            {row.dir ? '▸ ' : '  '}
            {row.label}
            <Text color="gray">{size}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function ChatPane({ state, active, width, height, scroll }: PaneProps & { scroll: number }) {
  const lines = renderLog(state.log, width - 4, state.self?.peerId);
  const visible = windowLines(lines, height - 2, scroll);
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={border(active)} paddingX={1}>
      {state.log.length === 0 ? (
        <Text color="gray">Say hi, or try "@claude what is in this repo?" — :help for everything</Text>
      ) : null}
      {visible.map((line, i) => (
        <Text key={i} color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate">
          {line.text || ' '}
        </Text>
      ))}
      {scroll > 0 ? <Text color="yellow">↓ {scroll} more (G to jump to latest)</Text> : null}
    </Box>
  );
}

export function ViewerPane({ state, active, width, height }: PaneProps) {
  const v = state.viewer;
  if (!v) return null;
  const inner = height - 3;
  const lines = v.content.split('\n');
  const gutter = String(lines.length).length;
  const shown = lines.slice(v.scroll, v.scroll + inner);
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={border(active)}>
      <Text bold color={active ? 'cyan' : 'white'} wrap="truncate-start">
        {' '}
        {peerName(state, v.owner)}:{v.share}/{v.path}
        {v.by ? <Text color="yellowBright"> ◉ {v.by}</Text> : null}
        {v.loading ? <Text color="gray"> ⟳</Text> : <Text color="green"> ● live</Text>}
      </Text>
      {v.error ? <Text color="red"> {v.error}</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate">
          <Text color="gray">{String(v.scroll + i + 1).padStart(gutter)} </Text>
          {line.replace(/\t/g, '  ') || ' '}
        </Text>
      ))}
      {v.truncated ? <Text color="yellow"> [file truncated at 512KB]</Text> : null}
    </Box>
  );
}

export function ApprovalBar({ approvals, width }: { approvals: readonly Approval[]; width: number }) {
  const first = approvals[0];
  if (!first) return null;
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow" wrap="truncate">
        {first.kind === 'tool' ? '⚠ ' : '✋ '}
        {first.title}
        {approvals.length > 1 ? <Text color="gray"> (+{approvals.length - 1} more)</Text> : null}
      </Text>
      {approvalLines(first.detail, width - 4).map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
      <Text color="gray">
        <Text color="green">Ctrl-Y</Text> allow · <Text color="red">Ctrl-N</Text> deny · in NORMAL mode: y / n / <Text color="cyan">a</Text> (always, for this person)
      </Text>
    </Box>
  );
}

const MODE_COLORS: Record<Mode, string> = { normal: 'blue', insert: 'green', command: 'yellow' };

export function StatusLine({ mode, pane, state }: { mode: Mode; pane: Pane; state: AppState }) {
  const hints =
    mode === 'normal'
      ? 'i chat · : cmd · @ ask claude · Tab pane · j/k move · q quit'
      : mode === 'insert'
        ? 'Enter send · Esc normal · Tab panes · @claude / @claude:<peer> / @claudes'
        : 'Enter run · Esc cancel · :help';
  return (
    <Box height={1}>
      <Text backgroundColor={MODE_COLORS[mode]} color="black" bold>
        {' '}
        {mode.toUpperCase()}{' '}
      </Text>
      <Text backgroundColor="gray" color="black">
        {' '}
        {pane}{' '}
      </Text>
      <Text color="gray" wrap="truncate">
        {' '}
        policy:{state.policy} · {hints}
      </Text>
    </Box>
  );
}

export function Prompt({ mode, buffer, cursor }: { mode: Mode; buffer: string; cursor: number }) {
  const prefix = mode === 'command' ? ':' : mode === 'insert' ? '› ' : '  ';
  const before = buffer.slice(0, cursor);
  const at = buffer[cursor] ?? ' ';
  const after = buffer.slice(cursor + 1);
  return (
    <Box height={1}>
      <Text color={mode === 'command' ? 'yellow' : 'green'}>{prefix}</Text>
      {mode === 'normal' ? (
        <Text color="gray">press i to type</Text>
      ) : (
        <Text wrap="truncate-start">
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
