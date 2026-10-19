import React from 'react';
import { tilde } from '../../core/paths.js';
import type { AppState } from '../../core/store.js';
import type { TerminalEmulator } from '../../terminal/index.js';
import type { Derived } from '../derive.js';
import type { UiState } from '../keymap.js';
import type { Model } from '../workspace-models.js';
import { ChatView } from './ChatView.js';
import { FilesPanel } from './FilesPanel.js';
import { HelpOverlay } from './HelpOverlay.js';
import { Menu } from './Menu.js';
import { ModelBlock } from './ModelBlock.js';
import { Panel } from './Panel.js';
import { TerminalView } from './TerminalView.js';
import { Viewer } from './Viewer.js';

interface MainPaneProps {
  readonly state: AppState;
  readonly d: Derived;
  readonly ui: UiState;
  readonly frame: number;
  readonly terminal: { readonly session?: TerminalEmulator; readonly bar?: Model; readonly focused: boolean };
}

/** The big area right of the sidebar: a menu, help, or whatever the current view shows. */
export function MainPane({ state, d, ui, frame, terminal }: MainPaneProps) {
  const g = d.geometry;
  const paneW = g.mainWidth;
  const termSession = terminal.session;
  const termBar = terminal.bar;
  const termFocused = terminal.focused;
    if (d.menu && ui.menu) return <Menu spec={d.menu} selected={ui.menu.selected} width={paneW} height={g.bodyHeight - 2} />;
  if (state.overlay === 'help') return <HelpOverlay width={paneW} height={g.paneHeight} scroll={ui.overlayScroll} />;
  const viewer = <Viewer state={state} width={g.viewerWidth} height={g.paneHeight} focused={d.focus === 'viewer'} raw={ui.viewerRaw} full={false} />;
  switch (state.view.kind) {
    case 'files':
      return (
        <>
          <FilesPanel state={state} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'files'} />
          {viewer}
        </>
      );
    case 'overview':
      return (
        <Panel title="" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
          <ModelBlock lines={d.overview?.lines ?? []} height={g.paneHeight - 2} scroll={d.overviewScroll} />
        </Panel>
      );
    case 'search':
      return (
        <Panel title="" width={paneW} height={g.paneHeight} focused={d.focus === 'main' || d.focus === 'chat'}>
          <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
        </Panel>
      );
    case 'terminal':
      return terminal.bar ? <TerminalView session={termSession} bar={terminal.bar} width={paneW} height={g.paneHeight} focused={termFocused} scroll={ui.terminalScroll ?? 0} title="" /> : null;
    case 'usage':
      return (
        <Panel title="" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
          <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
        </Panel>
      );
    case 'workspace': {
      const ws = d.workspace;
      if (!ws) return <Panel title="Workspace" width={paneW} height={g.paneHeight}>{null}</Panel>;
      if (state.view.tab === 'review') {
        return (
          <Panel title="Review" right="Ask Claude to review · Merge in the bar above" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
            <ModelBlock lines={d.review?.lines ?? []} height={g.paneHeight - 2} />
          </Panel>
        );
      }
      if (state.view.tab === 'files') {
        return (
          <>
            <FilesPanel state={state} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'files'} title={`${ws.name} files`} />
            {viewer}
          </>
        );
      }
      if (state.view.tab === 'terminal' && termBar) {
        return <TerminalView session={termSession} bar={termBar} width={paneW} height={g.paneHeight} focused={termFocused} scroll={ui.terminalScroll ?? 0} title={`${ws.name} terminal`} />;
      }
      return <ChatView state={state} channel={d.channel} title={`Claude in ${ws.name}`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} hoverLink={d.chatHover} />;
    }
    case 'shared': {
      const w = d.shared;
      if (!w) return <Panel title="Shared workspace" width={paneW} height={g.paneHeight}>{null}</Panel>;
      if (state.view.tab === 'files') {
        return (
          <>
            <FilesPanel state={state} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'files'} title={`${w.name} files`} />
            {viewer}
          </>
        );
      }
      if (state.view.tab === 'terminal') {
        return (
          <>
            <Panel title={`${w.name} terminal`} right={g.viewerWidth ? 'click a name to open it' : 'type a command below · click a name to open it'} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'chat'}>
              <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} />
            </Panel>
            {viewer}
          </>
        );
      }
      if (state.view.tab === 'diff') {
        return (
          <Panel title={`What changed in ${w.name}`} right="read-only · ↑↓ files · PgUp PgDn scroll" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
            <ModelBlock lines={d.review?.lines ?? []} height={g.paneHeight - 2} />
          </Panel>
        );
      }
      return <ChatView state={state} channel={d.channel} title={`${w.name} · with ${state.peers.find((p) => p.peerId === w.owner)?.name ?? 'owner'}'s Claude`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} hoverLink={d.chatHover} />;
    }
    case 'draft_worktree': {
      const project = state.projects.find((p) => p.id === (state.view as { projectId: string }).projectId);
      return (
        <Panel title={`New worktree in ${project?.name ?? 'project'} · from the latest origin`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'}>
          <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
        </Panel>
      );
    }
    case 'draft': {
      const where = state.view.dir ?? state.projects.find((p) => p.id === (state.view as { projectId: string }).projectId)?.root ?? '';
      return (
        <Panel title={`New Claude chat · ${tilde(where)}`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'}>
          <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
        </Panel>
      );
    }
    default:
      return (
        <>
          <ChatView state={state} title="" width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} hoverLink={d.chatHover} />
          {viewer}
        </>
      );
  }
  
}
