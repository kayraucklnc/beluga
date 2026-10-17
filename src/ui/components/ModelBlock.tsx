import React from 'react';
import { Box } from 'ink';
import type { Line } from '../text.js';
import { LineView } from './LineView.js';

interface ModelBlockProps {
  readonly lines: readonly Line[];
  readonly height: number;
  readonly scroll?: number;
  /** Highlight one row (keyboard cursor). */
  readonly highlight?: number;
}

/** Draws pre-computed lines in a fixed-height window. */
export function ModelBlock({ lines, height, scroll = 0, highlight }: ModelBlockProps) {
  const shown = lines.slice(scroll, scroll + Math.max(0, height));
  return (
    <Box flexDirection="column" height={Math.max(0, height)} overflow="hidden">
      {shown.map((line, i) => (
        <LineView key={i} line={scroll + i === highlight ? line.map((s) => ({ ...s, inverse: true })) : line} />
      ))}
    </Box>
  );
}
