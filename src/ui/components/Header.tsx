import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { peerName } from '../../core/store.js';
import { glyph, theme } from '../theme.js';

const STATUS = {
  connected: { label: 'live', color: theme.ok, icon: glyph.dot },
  connecting: { label: 'connecting…', color: theme.warn, icon: glyph.wait },
  disconnected: { label: 'offline · reconnecting', color: theme.error, icon: glyph.fail },
} as const;

export function Header({ state, width }: { state: AppState; width: number }) {
  const st = STATUS[state.status];
  const people = state.peers.length;
  return (
    <Box width={width} paddingX={1} height={1}>
      <Text bold color={theme.accent}>
        {glyph.logo} klaude
      </Text>
      <Text color={theme.muted}>{'  '}</Text>
      <Text bold>{state.room}</Text>
      <Box flexGrow={1} />
      {state.follow ? (
        <Text color={theme.warn}>
          {glyph.eye} following {peerName(state, state.follow)}
          {'   '}
        </Text>
      ) : null}
      <Text color={theme.muted}>
        {people} {people === 1 ? 'person' : 'people'}
        {'   '}
      </Text>
      <Text color={st.color}>
        {st.icon} {st.label}
      </Text>
      {state.invite ? <Text color={theme.muted}>{'   '}/invite</Text> : null}
    </Box>
  );
}
