import React from 'react';
import { Text } from 'ink';
import { COMMANDS } from '../../core/commands.js';
import { theme } from '../theme.js';
import { Panel } from './Panel.js';

type Row = { readonly kind: 'title'; readonly text: string } | { readonly kind: 'row'; readonly key: string; readonly desc: string; readonly color: string };

const TALK: ReadonlyArray<readonly [string, string]> = [
  ['hello!', 'message everyone'],
  ['@claude fix the tests', 'your Claude, on your machine'],
  ['@claude:bob review this', "Bob's Claude, on Bob's machine (Bob approves)"],
  ['@claudes ideas?', 'every Claude at once'],
  ["get bob's ~/Desktop/report.pdf onto my desktop", 'your Claude asks bob’s computer (bob approves, unless he fully trusts you)'],
];

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Tab / Shift+Tab', 'walk through every button and area'],
  ['Ctrl+]', 'leave the built-in terminal (or click anywhere else)'],
  ['Enter / Option+Enter', 'send (queued while Claude works) / interrupt and send now'],
  ['1 – 4', "pick an option on Claude's question card"],
  ['Option+Q / Option+L', 'type @ on Turkish / German Macs'],
  ['Esc', 'back to chat'],
  ['↑ ↓', 'history (or pick a suggestion)'],
  ['PgUp PgDn', 'scroll chat'],
  ['Ctrl+Y / Ctrl+N / Ctrl+T', 'allow / deny / always allow'],
  ['Option+↑ / Option+↓', 'make text bigger / smaller'],
  ['Ctrl+C twice', 'quit'],
];

export const HELP_ROWS: readonly Row[] = [
  { kind: 'title', text: 'Talk' },
  ...TALK.map(([key, desc]) => ({ kind: 'row' as const, key, desc, color: theme.claude })),
  { kind: 'title', text: 'Commands' },
  ...COMMANDS.map((c) => ({ kind: 'row' as const, key: `/${c.name}${c.args ? ` ${c.args}` : ''}`, desc: c.desc, color: theme.info })),
  { kind: 'title', text: 'Keys' },
  ...KEYS.map(([key, desc]) => ({ kind: 'row' as const, key, desc, color: theme.text })),
];

const PAD = Math.max(...HELP_ROWS.map((r) => (r.kind === 'row' ? r.key.length : 0))) + 3;

export function HelpOverlay({ width, height, scroll }: { width: number; height: number; scroll: number }) {
  const avail = Math.max(1, height - 2);
  const maxScroll = Math.max(0, HELP_ROWS.length - avail);
  const start = Math.min(scroll, maxScroll);
  const rows = HELP_ROWS.slice(start, start + avail);
  const more = maxScroll > 0 ? `${start > 0 ? '↑' : ' '}${start < maxScroll ? '↓' : ' '} scroll · Esc close` : 'Esc to close';
  return (
    <Panel title="Help" right={more} width={width} height={height} focused>
      {rows.map((r, i) =>
        r.kind === 'title' ? (
          <Text key={i} bold>
            {r.text}
          </Text>
        ) : (
          <Text key={i} wrap="truncate">
            <Text color={r.color} bold>
              {'  '}
              {r.key.padEnd(PAD)}
            </Text>
            <Text color={theme.muted}>{r.desc}</Text>
          </Text>
        ),
      )}
    </Panel>
  );
}
