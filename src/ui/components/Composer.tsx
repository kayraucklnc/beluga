import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import type { Toast, Transfer } from '../../core/store.js';
import { type ActionButton, buttonLabel } from '../actions.js';
import { ACTION_GAP } from '../hit.js';
import type { Focus } from '../keymap.js';
import { type Suggestion, suggestionWindow } from '../suggest.js';
import { type Line, type Seg, formatSize, lineWidth, truncate, width } from '../text.js';
import { LineView } from './LineView.js';
import { type Row, charAfter, rowOf, wrapBuffer } from '../composer-text.js';
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
  /** Rows of text to show (from the layout) and the columns the draft wraps at. */
  readonly lines?: number;
  readonly wrapWidth?: number;
}

/** First row to show so the cursor's row stays in view, moving as little as possible. */
export function composerScroll(prev: number, cursorRow: number, total: number, lines: number): number {
  let top = Math.min(prev, Math.max(0, total - lines));
  if (cursorRow < top) top = cursorRow;
  if (cursorRow >= top + lines) top = cursorRow - lines + 1;
  return Math.max(0, top);
}

/** One row of the draft, with the cursor drawn on it if it's there. */
function DraftRow({ buffer, row, cursor, active }: { buffer: string; row: Row; cursor?: number; active: boolean }) {
  if (cursor === undefined) return <Text wrap="truncate">{buffer.slice(row.start, row.end) || ' '}</Text>;
  const at = cursor < row.end ? buffer.slice(cursor, cursor + charAfter(buffer, cursor)) : ' ';
  return (
    <Text wrap="truncate">
      {buffer.slice(row.start, cursor)}
      {active ? <Text inverse>{at}</Text> : at}
      {buffer.slice(cursor + (cursor < row.end ? at.length : 0), row.end)}
    </Text>
  );
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

export function Composer({ width, buffer, cursor, focus, suggestions, selected, buttons, toast, transfer, placeholder, accent, hint, hoveredButton, right, idleHint, lines = 1, wrapWidth = Math.max(4, width - 7) }: ComposerProps) {
  const active = focus === 'chat';
  const rows = buffer ? wrapBuffer(buffer, wrapWidth) : [];
  const cursorRow = rowOf(rows, cursor);
  const scrollRef = useRef(0);
  const top = composerScroll(scrollRef.current, cursorRow, rows.length, lines);
  scrollRef.current = top;
  const shown = rows.slice(top, top + lines);
  const below = Math.max(0, rows.length - top - lines);
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
        <Box width={2} flexShrink={0}>
          <Text color={active ? theme.accent : theme.muted}>{glyph.prompt} </Text>
        </Box>
        <Box flexDirection="column" width={wrapWidth + 1} flexShrink={0}>
          {buffer ? (
            shown.map((row, i) => <DraftRow key={top + i} buffer={buffer} row={row} cursor={top + i === cursorRow ? cursor : undefined} active={active} />)
          ) : (
            <Text wrap="truncate">
              {active ? <Text inverse> </Text> : null}
              <Text color={theme.muted}>{active ? (placeholder ?? 'Message the room…  @ to ask a Claude, / for commands') : (idleHint ?? 'Click here or press Esc to type')}</Text>
            </Text>
          )}
        </Box>
        {right ? (
          <>
            <Box flexGrow={1} />
            <Box flexShrink={0} flexDirection="column" alignItems="flex-end">
              <LineView line={right} />
              {/* A draft taller than the box scrolls inside it; say how much is out of view. */}
              {shown.length > 1 ? (
                <>
                  <Text color={theme.muted}>{top ? `↑ ${top} more line${top === 1 ? '' : 's'}` : shown.length === 2 && below ? `↓ ${below} more` : ' '}</Text>
                  {shown.length > 3 ? <Box height={shown.length - 3} /> : null}
                  {shown.length > 2 ? <Text color={theme.muted}>{below ? `↓ ${below} more line${below === 1 ? '' : 's'}` : ' '}</Text> : null}
                </>
              ) : null}
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
