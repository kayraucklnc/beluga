import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { inviteBanner } from '../banner.js';
import { renderLog } from '../format.js';
import { type Line, windowLines } from '../text.js';
import { theme } from '../theme.js';
import { LineView } from './LineView.js';
import { Panel } from './Panel.js';

interface ChatViewProps {
  readonly state: AppState;
  readonly channel?: string;
  readonly title?: string;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly scroll: number;
  readonly frame: number;
}

const EMPTY_HINT: Line[] = [
  [{ text: 'Say hi, or ask a Claude something:', color: theme.muted }],
  [],
  [{ text: '  @claude ', color: theme.claude, bold: true }, { text: 'what does this project do?', color: theme.muted }],
  [{ text: '  @claude:<friend> ', color: theme.claude, bold: true }, { text: "runs on your friend's machine", color: theme.muted }],
  [{ text: '  /help ', color: theme.info, bold: true }, { text: 'everything else', color: theme.muted }],
];

const WORKSPACE_HINT: Line[] = [
  [{ text: 'This is your private conversation with Claude in this workspace.', color: theme.muted }],
  [{ text: 'Claude works inside its folder. Just type what you want done.', color: theme.muted }],
  [],
  [{ text: '  Review, Merge, Fork and Archive', color: theme.text }, { text: ' are in the bar above.', color: theme.muted }],
];

/** Chat lines for a pane of this size (exported so App can bound scrolling). */
export function chatLines(state: AppState, cols: number, frame: number, channel = 'room'): Line[] {
  if (cols <= 0) return []; // hidden (e.g. the viewer is fullscreen)
  const items = state.log.filter((l) => l.channel === channel);
  const banner = channel === 'room' ? inviteBanner(state, cols, frame) : [];
  const log = renderLog(items, cols, { selfId: state.self?.peerId, frame, now: Date.now() });
  return [...banner, ...(items.length ? log : channel === 'room' ? EMPTY_HINT : WORKSPACE_HINT)];
}

export function ChatView({ state, channel = 'room', title = 'Chat', width, height, focused, scroll, frame }: ChatViewProps) {
  const cols = width - 4;
  const lines = chatLines(state, cols, frame, channel);
  const visible = windowLines(lines, height - 2, scroll);
  return (
    <Panel title={title} width={width} height={height} focused={focused} right={scroll > 0 ? `↓ ${scroll} newer · PgDn` : ''} rightColor={theme.warn}>
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {visible.map((line, i) => (
          <LineView key={i} line={line} />
        ))}
      </Box>
      {state.status !== 'connected' && state.log.length === 0 ? <Text color={theme.warn}>Connecting to the room…</Text> : null}
    </Panel>
  );
}
