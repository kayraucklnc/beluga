import React from 'react';
import { Text } from 'ink';
import { type Line, lineWidth } from '../text.js';

/** Render one pre-styled line. Lines are already sized, so Ink must not re-wrap them. */
export function LineView({ line }: { line: Line }) {
  // An empty Text collapses to zero height in Ink, which would swallow blank lines.
  if (lineWidth(line) === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} italic={s.italic} underline={s.underline} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
