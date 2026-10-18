import { channelOf } from '@klaud/core/store.js';
import { Attention } from '../chat/Attention.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Composer } from '../chat/Composer.js';
import { Empty } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import s from './views.module.css';

/** A conversation and the box to add to it: the room, a workspace, a shared workspace, a draft. */
export function ChatView() {
  const view = useApp((st) => st.view);
  const solo = useApp((st) => st.peers.length <= 1);
  const channel = channelOf(view);
  const empty =
    view.kind === 'draft' ? (
      <Empty icon="chat" title="A new chat with Claude" detail="Nothing is created until you send your first message." />
    ) : view.kind === 'draft_worktree' ? (
      <Empty icon="branch" title="A new worktree" detail="Describe the task. klaud names a branch from it, makes the worktree from the latest origin, and Claude starts right away." />
    ) : view.kind === 'room' ? (
      <Empty icon="spark" title={solo ? 'Talk to your Claude' : 'Say hi to the room'} detail={solo ? 'Ask anything. Mention @a-workspace to reach the Claude working there, or press / for commands.' : 'Everyone here sees this chat. @claude:name asks someone’s Claude.'} />
    ) : (
      <Empty icon="chat" title="Tell Claude what to do here" detail="It works in this folder, and remembers the conversation." />
    );
  return (
    <div className={s.chat}>
      <ChatLog key={channel} channel={channel === 'draft' ? '__draft__' : channel} empty={empty} />
      <Attention />
      <Composer />
    </div>
  );
}
