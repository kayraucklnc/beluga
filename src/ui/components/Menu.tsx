import React from 'react';
import { Text } from 'ink';
import type { MenuSpec } from '../menus.js';
import { theme } from '../theme.js';
import { Panel } from './Panel.js';

interface MenuProps {
  readonly spec: MenuSpec;
  readonly selected: number;
  readonly width: number;
  readonly height: number;
}

/** A choice list you can use with ↑↓/Enter, number keys, or the mouse. */
export function Menu({ spec, selected, width, height }: MenuProps) {
  const labelWidth = Math.max(...spec.options.map((o) => o.label.length)) + 3;
  return (
    <Panel title={spec.title} right="↑↓ choose · Enter · click" width={width} height={height} focused>
      {spec.intro.map((line, i) => (
        <Text key={`i${i}`} color={theme.text} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
      <Text> </Text>
      {spec.options.map((o, i) => {
        const active = i === selected;
        return (
          <Text key={o.id} wrap="truncate">
            <Text color={active ? theme.accent : theme.muted}>{active ? ' ▸ ' : '   '}</Text>
            <Text color={theme.muted}>{i + 1}  </Text>
            <Text color={active ? theme.text : theme.muted} bold={active}>
              {o.label.padEnd(labelWidth)}
            </Text>
            <Text color={theme.muted}>{o.hint ?? ''}</Text>
          </Text>
        );
      })}
    </Panel>
  );
}
