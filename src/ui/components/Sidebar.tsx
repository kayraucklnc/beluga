import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../../core/store.js';
import { peopleRows } from '../banner.js';
import type { Model } from '../workspace-models.js';
import { glyph, theme } from '../theme.js';
import { LineView } from './LineView.js';
import { ModelBlock } from './ModelBlock.js';
import { Panel } from './Panel.js';

interface SidebarProps {
  readonly state: AppState;
  readonly width: number;
  readonly projectsHeight: number;
  readonly peopleHeight: number;
  readonly projects: Model;
  readonly projectsScroll: number;
  readonly projectsCursorRow?: number;
  readonly focus: 'projects' | 'people' | 'other';
  readonly peopleCursor: number;
  readonly frame: number;
}

/** Left column: your projects and workspaces, then the people in the room. */
export function Sidebar({ state, width, projectsHeight, peopleHeight, projects, projectsScroll, projectsCursorRow, focus, peopleCursor, frame }: SidebarProps) {
  const people = peopleRows(state, frame);
  const peopleFocused = focus === 'people';
  return (
    <Box flexDirection="column" width={width}>
      <Panel title="Projects" width={width} height={projectsHeight} focused={focus === 'projects'} right={focus === 'projects' ? '↵ open' : 'click'}>
        <ModelBlock lines={projects.lines} height={projectsHeight - 2} scroll={projectsScroll} highlight={focus === 'projects' ? projectsCursorRow : undefined} />
      </Panel>
      {peopleHeight > 0 ? (
        <Panel title="People" width={width} height={peopleHeight} focused={peopleFocused} right={peopleFocused ? '↵ actions' : 'click'}>
          {people.map((p, i) => (
            <Box key={p.peerId} flexDirection="column">
              <Text wrap="truncate" inverse={peopleFocused && i === peopleCursor}>
                <Text color={p.color}>{glyph.dot} </Text>
                <Text bold>{p.name}</Text>
                {p.you ? <Text color={theme.muted}> (you)</Text> : null}
                {p.tags ? <Text color={theme.ok}> {p.tags}</Text> : null}
                {state.follow === p.peerId ? <Text color={theme.warn}> {glyph.eye} following</Text> : null}
              </Text>
              <Box paddingLeft={2}>
                <LineView line={p.agent} />
              </Box>
            </Box>
          ))}
        </Panel>
      ) : null}
    </Box>
  );
}
