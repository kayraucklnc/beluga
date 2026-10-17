import React from 'react';
import { Box, Text } from 'ink';
import type { Approval } from '../../core/store.js';
import { approvalLines } from '../format.js';
import { theme } from '../theme.js';

export function approvalHeight(approval: Approval | undefined, width: number): number {
  return approval ? 4 + approvalLines(approval.detail, width - 4).length : 0;
}

export function ApprovalCard({ approvals, width }: { approvals: readonly Approval[]; width: number }) {
  const first = approvals[0];
  if (!first) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1} width={width}>
      <Text bold color={theme.warn} wrap="truncate">
        {first.kind === 'tool' ? '! ' : '? '}
        {first.title}
        {approvals.length > 1 ? <Text color={theme.muted}>  (+{approvals.length - 1} waiting)</Text> : null}
      </Text>
      {approvalLines(first.detail, width - 4).map((line, i) => (
        <Text key={i} wrap="truncate" color={theme.text}>
          {line || ' '}
        </Text>
      ))}
      <Text>
        <Text color={theme.ok} bold>
          Ctrl+Y
        </Text>
        <Text color={theme.muted}> allow    </Text>
        <Text color={theme.error} bold>
          Ctrl+N
        </Text>
        <Text color={theme.muted}> deny    </Text>
        <Text color={theme.text} bold>
          Ctrl+T
        </Text>
        <Text color={theme.muted}> always allow this person</Text>
      </Text>
    </Box>
  );
}
