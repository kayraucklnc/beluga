import { channelOf } from '@klaud/core/store.js';
import { Attention } from '../chat/Attention.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Composer } from '../chat/Composer.js';
import { Button, Empty, EmptyActions } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useRef } from 'react';
import { useApp } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { DockDivider, DockedTerminal } from './DockedTerminal.js';
import d from './dock.module.css';
import s from './views.module.css';

/** A conversation and the box to add to it: the room, a workspace, a shared workspace, a draft. */
/** One-click ways to begin, under an empty conversation. */
function Starters() {
  const actions = useActions();
  const view = useApp((st) => st.view);
  const project = useApp((st) => st.projects.find((p) => p.root && (view.kind !== 'workspace' || p.workspaces.some((w) => w.id === view.id))));
  if (view.kind === 'room') {
    return (
      <EmptyActions>
        {project ? (
          <Button variant="primary" icon="branch" onClick={() => actions.run({ type: 'new_worktree', projectId: project.id })}>
            New Worktree
          </Button>
        ) : (
          <Button variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
            Add Projects…
          </Button>
        )}
        <Button icon="chat" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })}>
          New Chat
        </Button>
        {project ? (
          <Button variant="quiet" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
            Add Projects…
          </Button>
        ) : null}
      </EmptyActions>
    );
  }
  if (view.kind !== 'workspace') return null;
  // A first task, sent with one click.
  return (
    <EmptyActions>
      {STARTERS.map((t) => (
        <Button key={t.label} icon={t.icon} onClick={() => actions.submit(t.prompt)}>
          {t.label}
        </Button>
      ))}
    </EmptyActions>
  );
}

const STARTERS = [
  { label: 'Explain This Project', icon: 'eye', prompt: 'Explain how this project is organized: the main parts, how they fit together, and where to start reading.' },
  { label: 'Find a Bug', icon: 'search', prompt: 'Look through the code for a likely bug, explain it, and fix it with a test.' },
  { label: 'Add Tests', icon: 'check', prompt: 'Find the most important code without tests and write good tests for it.' },
] as const;

export function ChatView() {
  const view = useApp((st) => st.view);
  const solo = useApp((st) => st.peers.length <= 1);
  const channel = channelOf(view);
  const empty =
    view.kind === 'draft' ? (
      <Empty icon="chat" title="A new chat with Claude" detail="Nothing is created until you send your first message." />
    ) : view.kind === 'draft_worktree' ? (
      <Empty icon="branch" title="A new worktree" detail="Describe the task below. klaud makes a branch and a folder for it from the branch you pick, and Claude starts right away." />
    ) : view.kind === 'room' ? (
      <Empty icon="claude" title={solo ? 'Talk to your Claude' : 'Say hi to the room'} detail={solo ? 'Ask anything here, or give Claude a task in a worktree of its own.' : 'Everyone here sees this chat. Mention @claude to ask your Claude.'} action={<Starters />} />
    ) : (
      <Empty icon="chat" title="Tell Claude what to do here" detail="It works in this folder and remembers the conversation. Start with one of these, or write your own below." action={<Starters />} />
    );
  const prefs = usePrefs();
  const split = useRef<HTMLDivElement>(null);
  const chat = (
    <div className={s.chat}>
      <ChatLog key={channel} channel={channel === 'draft' ? '__draft__' : channel} empty={empty} />
      <Attention />
      <Composer />
    </div>
  );
  // A shared workspace's terminal is its owner's; the dock is for your own.
  if (prefs.dock === 'off' || view.kind === 'shared') return chat;
  const size = `${Math.round(prefs.dockSize * 100)}%`;
  return (
    <div ref={split} className={`${d.split} ${prefs.dock === 'right' ? d.right : d.bottom}`}>
      <div className={d.main}>{chat}</div>
      <DockDivider container={split} />
      <div style={prefs.dock === 'right' ? { width: size, display: 'flex' } : { height: size, display: 'flex' }}>
        <DockedTerminal />
      </div>
    </div>
  );
}
