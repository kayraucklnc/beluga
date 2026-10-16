import React from 'react';
import { Box, Text } from 'ink';
import type { Toast } from '../../core/store.js';
import type { Suggestion } from '../suggest.js';
import { glyph, theme } from '../theme.js';
import type { Focus } from '../keymap.js';

interface ComposerProps {
  readonly width: number;
  readonly buffer: string;
  readonly cursor: number;
  readonly focus: Focus;
  readonly suggestions: readonly Suggestion[];
  readonly selected: number;
  readonly toast?: Toast;
}

const TOAST_COLORS: Record<Toast['level'], string> = { info: theme.info, success: theme.ok, warn: theme.warn, error: theme.error };

const HINTS: Record<Focus, string> = {
  chat: 'Enter send · @ mention a Claude · / commands · Tab files · Ctrl+C quit',
  files: '↑↓ move · Enter open · ← back · Esc chat',
  viewer: '↑↓ PgUp PgDn scroll · Backspace close · Esc chat',
};

export function Composer({ width, buffer, cursor, focus, suggestions, selected, toast }: ComposerProps) {
  const active = focus === 'chat';
  const labelWidth = Math.min(28, Math.max(...suggestions.map((s) => s.label.length), 0) + 2);
  return (
    <Box flexDirection="column" width={width}>
      {active && suggestions.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.map((s, i) => (
            <Text key={s.value} wrap="truncate">
              <Text color={i === selected ? theme.focus : theme.muted}>{i === selected ? '▸ ' : '  '}</Text>
              <Text bold={i === selected} color={i === selected ? theme.text : theme.muted}>
                {s.label.padEnd(labelWidth)}
              </Text>
              <Text color={theme.muted}>{s.hint}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={active ? theme.focus : theme.border} paddingX={1} width={width}>
        <Text color={active ? theme.focus : theme.muted}>{glyph.prompt} </Text>
        {buffer ? (
          <Text wrap="truncate-start">
            {buffer.slice(0, cursor)}
            {active ? <Text inverse>{buffer[cursor] ?? ' '}</Text> : buffer[cursor] ?? ''}
            {buffer.slice(cursor + 1)}
          </Text>
        ) : (
          <Text wrap="truncate">
            {active ? <Text inverse> </Text> : null}
            <Text color={theme.muted}>Message the room…  try @claude or /help</Text>
          </Text>
        )}
      </Box>
      <Box paddingX={2} height={1}>
        <Text color={theme.muted} wrap="truncate">
          {active && suggestions.length > 0 ? 'Tab complete · ↑↓ choose · Esc hide' : HINTS[focus]}
        </Text>
        <Box flexGrow={1} />
        {toast ? <Text color={TOAST_COLORS[toast.level]}>{toast.text}</Text> : null}
      </Box>
    </Box>
  );
}
