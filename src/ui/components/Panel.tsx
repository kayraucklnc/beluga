import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { width as textWidth } from '../text.js';

interface PanelProps {
  readonly title: string;
  readonly right?: string;
  readonly rightColor?: string;
  readonly width: number;
  readonly height: number;
  readonly focused?: boolean;
  readonly children: ReactNode;
}

/** A rounded box with its title drawn into the top border. */
export function Panel({ title, right = '', rightColor, width, height, focused = false, children }: PanelProps) {
  const color = focused ? theme.focus : theme.border;
  const maxTitle = Math.max(1, width - textWidth(right) - 8);
  const shown = textWidth(title) > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title;
  const fill = Math.max(1, width - 6 - textWidth(shown) - (right ? textWidth(right) + 2 : 0));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={color}>╭─ </Text>
        <Text color={focused ? theme.focus : theme.text} bold>
          {shown}
        </Text>
        <Text color={color}> {'─'.repeat(fill)}</Text>
        {right ? <Text color={rightColor ?? theme.muted}> {right} </Text> : null}
        <Text color={color}>─╮</Text>
      </Text>
      <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={color} paddingX={1} height={height - 1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
