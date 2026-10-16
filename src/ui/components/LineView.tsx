import React from 'react';
import { Text } from 'ink';
import type { Line } from '../text.js';

/** Render one pre-styled line. Lines are already sized, so Ink must not re-wrap them. */
export function LineView({ line }: { line: Line }) {
  if (line.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} italic={s.italic} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
