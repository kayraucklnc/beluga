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
  const solo = state.status === 'connected' && state.peers.length <= 1 && !state.hosting && !state.invite;
  const st = solo ? { label: 'solo', color: theme.muted, icon: glyph.ring } : STATUS[state.status];
  const people = state.peers.length;
  const mine = state.peers.find((p) => p.peerId === state.self?.peerId)?.usage;
  return (
    <Box width={width} paddingX={1} height={1}>
      <Text bold color={theme.text}>
        {glyph.logo}
      </Text>
      <Text bold color={theme.accent}>
        _{' '}
      </Text>
      <Text bold color={theme.text}>
        klaude
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
      {mine?.fiveHour || mine?.week ? (
        <Text color={theme.muted}>
          your Claude {mine.fiveHour ? `5h ${mine.fiveHour.pct}%` : ''}
          {mine.fiveHour && mine.week ? ' · ' : ''}
          {mine.week ? `week ${mine.week.pct}%` : ''}
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
