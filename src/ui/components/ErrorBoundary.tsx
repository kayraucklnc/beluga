import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

interface State {
  readonly error?: Error;
}

/** Keeps a rendering bug from crashing the room; shows what happened and how to recover. */
export class ErrorBoundary extends React.Component<{ children: ReactNode }, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.error} paddingX={1}>
        <Text color={theme.error} bold>
          klaude hit a display bug and paused the screen.
        </Text>
        <Text>{this.state.error.message}</Text>
        <Text color={theme.muted}>Your room is still connected. Resize the window or press Ctrl+C twice to quit and restart.</Text>
      </Box>
    );
  }
}
