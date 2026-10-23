import React from 'react';
import { Box, Text } from 'ink';
import { type TerminalEmulator, overlayCursor } from '../../terminal/index.js';
import type { Model } from '../workspace-models.js';
import { theme } from '../theme.js';
import { LineView } from './LineView.js';
import { ModelBlock } from './ModelBlock.js';
import { Panel } from './Panel.js';

interface TerminalViewProps {
  readonly session?: TerminalEmulator;
  readonly bar: Model;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  /** Lines scrolled back into the history (0 = following the output). */
  readonly scroll: number;
  readonly title: string;
}

/** Terminal size that fits a pane of this size (the bar above + the panel's border). */
export const terminalSize = (width: number, height: number): { cols: number; rows: number } => ({ cols: Math.max(10, width - 4), rows: Math.max(3, height - 3) });

/** A real shell (or the setup / run command) drawn inside Beluga, with its sessions above it. */
export function TerminalView({ session, bar, width, height, focused, scroll, title }: TerminalViewProps) {
  const { rows } = terminalSize(width, height);
  const snap = session?.snapshot(scroll);
  const lines = snap?.lines ?? [];
  const cursor = focused && scroll === 0 ? snap?.cursor : undefined;
  const right = snap?.exited ? `exited${snap.exited.code !== null ? ` (${snap.exited.code})` : ''}` : scroll > 0 ? `↑ ${scroll} lines back · scroll down to follow` : '';
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} height={1}>
        <ModelBlock lines={bar.lines} height={1} />
      </Box>
      <Panel title={snap?.title || title} right={right} rightColor={focused ? theme.info : theme.muted} width={width} height={height - 1} focused={focused}>
        {session ? (
          Array.from({ length: rows }, (_, i) => {
            const line = lines[i] ?? [];
            return <LineView key={i} line={cursor && cursor.y === i ? overlayCursor(line, cursor.x) : line} />;
          })
        ) : (
          <Text color={theme.muted}>The terminal isn't available here.</Text>
        )}
      </Panel>
    </Box>
  );
}
