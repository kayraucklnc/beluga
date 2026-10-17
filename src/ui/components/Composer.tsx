import React from 'react';
import { Box, Text } from 'ink';
import type { Toast, Transfer } from '../../core/store.js';
import { type ActionButton, buttonLabel } from '../actions.js';
import { ACTION_GAP } from '../hit.js';
import type { Focus } from '../keymap.js';
import { type Suggestion, suggestionWindow } from '../suggest.js';
import { type Line, type Seg, formatSize, lineWidth, truncate, width } from '../text.js';
import { LineView } from './LineView.js';
import { glyph, theme } from '../theme.js';

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
      {/* One line that never wraps: a wrapped bar would push the screen up and leave stray text behind. */}
      <Box paddingX={2} height={1} overflow="hidden">
        {transfer?.status === 'active' ? (
          <>
            <Text wrap="truncate">{actionBarText(buttons)}</Text>
            <Box flexGrow={1} />
            <TransferStatus t={transfer} />
          </>
        ) : (
          <LineView line={barLine(buttons, hoveredButton, toast ? { text: toast.text, color: TOAST_COLORS[toast.level] } : hint ? { text: hint, color: theme.info } : undefined, width - 4)} />
        )}
      </Box>
    </Box>
  );
}

/** The bottom bar as one line: buttons on the left, the hint (shortened to fit) on the right. */
export function barLine(buttons: readonly ActionButton[], hovered: string | undefined, right: { text: string; color: string } | undefined, max: number): Line {
  const left: Seg[] = [];
  buttons.forEach((b, i) => {
    if (i > 0) left.push({ text: ' '.repeat(ACTION_GAP) });
    left.push({ text: b.text, color: theme.text, inverse: b.id === hovered });
    if (b.key) left.push({ text: ` ${b.key}`, color: theme.muted });
  });
  const used = lineWidth(left);
  const room = max - used - 2;
  if (!right || room < 8) return truncate(left, max);
  const text = width(right.text) <= room ? right.text : `${right.text.slice(0, room - 1)}…`;
  return [...left, { text: ' '.repeat(Math.max(2, max - used - width(text))) }, { text, color: right.color }];
}

export const actionBarText = (buttons: readonly ActionButton[]): string => buttons.map(buttonLabel).join(' '.repeat(ACTION_GAP));
