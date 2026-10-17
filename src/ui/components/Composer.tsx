import React from 'react';
import { Box, Text } from 'ink';
import type { Toast, Transfer } from '../../core/store.js';
import { type ActionButton, buttonLabel } from '../actions.js';
import { ACTION_GAP } from '../hit.js';
import type { Focus } from '../keymap.js';
import { type Suggestion, suggestionWindow } from '../suggest.js';
import { formatSize } from '../text.js';
import { glyph, theme } from '../theme.js';
import type { Line } from '../text.js';
import { LineView } from './LineView.js';

interface ComposerProps {
  readonly width: number;
  readonly buffer: string;
  readonly cursor: number;
  readonly focus: Focus;
  readonly suggestions: readonly Suggestion[];
  readonly selected: number;
  readonly buttons: readonly ActionButton[];
  readonly toast?: Toast;
  readonly transfer?: Transfer;
  /** Overrides the hint text in an empty composer. */
  readonly placeholder?: string;
  /** Right side of the box: the model picker and plan mode (clickable; positions come from derive). */
  readonly right?: Line;
  /** Highlight the composer border (e.g. while naming something). */
  readonly accent?: string;
  /** Description of the hovered control. */
  readonly hint?: string;
  readonly hoveredButton?: string;
  /** What the empty box says while something else has the keyboard. */
  readonly idleHint?: string;
}

const TOAST_COLORS: Record<Toast['level'], string> = { info: theme.info, success: theme.ok, warn: theme.warn, error: theme.error };

function TransferStatus({ t }: { t: Transfer }) {
  const pct = t.total ? Math.floor((t.received / t.total) * 100) : 0;
  const filled = Math.round(pct / 10);
  return (
    <Text color={theme.info}>
      ↓ {t.name} {'█'.repeat(filled)}
      <Text color={theme.border}>{'░'.repeat(10 - filled)}</Text> {pct}% <Text color={theme.muted}>of {formatSize(t.total)}</Text>
    </Text>
  );
}

export function Composer({ width, buffer, cursor, focus, suggestions, selected, buttons, toast, transfer, placeholder, accent, hint, hoveredButton, right, idleHint }: ComposerProps) {
  const active = focus === 'chat';
  const labelWidth = Math.min(34, Math.max(...suggestions.map((s) => s.label.length), 0) + 2);
  const win = suggestionWindow(suggestions.length, selected);
  const fit = (label: string): string => (label.length > labelWidth - 1 ? `${label.slice(0, labelWidth - 2)}…` : label).padEnd(labelWidth);
  return (
    <Box flexDirection="column" width={width}>
      {active && suggestions.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.slice(win.start, win.end).map((s, k) => {
            const i = win.start + k;
            return (
              <Text key={`${s.value}-${i}`} wrap="truncate">
                <Text color={i === selected ? theme.accent : theme.muted}>{i === selected ? '▸ ' : '  '}</Text>
                <Text bold={i === selected} color={i === selected ? theme.text : theme.muted}>
                  {fit(s.label)}
                </Text>
                <Text color={theme.muted}>{s.hint}</Text>
              </Text>
            );
          })}
          {win.rows > win.end - win.start ? (
            <Text color={theme.muted}>
              {'  '}
              {win.above ? `↑ ${win.above} more  ` : ''}
              {win.below ? `↓ ${win.below} more  ` : ''}
              <Text color={theme.border}>
                ({selected + 1}/{suggestions.length}) ↑↓ to scroll
              </Text>
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={accent ?? (active ? theme.focus : theme.border)} paddingX={1} width={width}>
        <Text color={active ? theme.accent : theme.muted}>{glyph.prompt} </Text>
        {buffer ? (
          <Text wrap="truncate-start">
            {buffer.slice(0, cursor)}
            {active ? <Text inverse>{buffer[cursor] ?? ' '}</Text> : buffer[cursor] ?? ''}
            {buffer.slice(cursor + 1)}
          </Text>
        ) : (
          <Text wrap="truncate">
            {active ? <Text inverse> </Text> : null}
            <Text color={theme.muted}>{active ? (placeholder ?? 'Message the room…  @ to ask a Claude, / for commands') : (idleHint ?? 'Click here or press Esc to type')}</Text>
          </Text>
        )}
        {right ? (
          <>
            <Box flexGrow={1} />
            <Box flexShrink={0}>
              <LineView line={right} />
            </Box>
          </>
        ) : null}
      </Box>
      <Box paddingX={2} height={1}>
        {buttons.map((b, i) => (
          <Text key={b.id}>
            {i > 0 ? ' '.repeat(ACTION_GAP) : ''}
            <Text color={theme.text} inverse={b.id === hoveredButton}>
              {b.text}
            </Text>
            {b.key ? <Text color={theme.muted}> {b.key}</Text> : null}
          </Text>
        ))}
        <Box flexGrow={1} />
        {transfer?.status === 'active' ? (
          <TransferStatus t={transfer} />
        ) : toast ? (
          <Text color={TOAST_COLORS[toast.level]}>{toast.text}</Text>
        ) : hint ? (
          <Text color={theme.info}>{hint}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

export const actionBarText = (buttons: readonly ActionButton[]): string => buttons.map(buttonLabel).join(' '.repeat(ACTION_GAP));
