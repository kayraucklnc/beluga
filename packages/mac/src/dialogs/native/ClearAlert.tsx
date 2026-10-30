import { useState } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Alert, Checkbox } from '../../components/Alert.js';
import { useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';

/** Clear a conversation. The choice the terminal lists (for everyone, a fresh Claude) is a checkbox. */
export function ClearAlert({ menu, close }: NativeMenuProps<'clear'>) {
  const pick = usePick(menu);
  const ws = useApp((st) => (menu.channel.startsWith('ws:') ? findWorkspace(st.projects, menu.channel.slice(3)) : undefined));
  const [more, setMore] = useState(false);
  if (menu.channel === 'room') {
    return (
      <Alert
        icon="chat"
        tone="caution"
        title="Clear the group chat?"
        message={menu.host ? 'The messages disappear from your screen.' : 'The messages disappear from your screen. Only the host can clear it for everyone.'}
        confirm={{ label: 'Clear', destructive: true, onClick: () => pick(more ? 'clear-everyone' : 'clear-mine') }}
        onCancel={close}
      >
        {menu.host ? <Checkbox checked={more} onChange={setMore} label="Clear it for everyone" detail="You host this room: people who join later won’t see it either" /> : null}
      </Alert>
    );
  }
  return (
    <Alert
      icon="chat"
      tone="caution"
      title={`Clear “${ws?.name ?? 'this conversation'}”?`}
      message={more ? 'The messages here are removed, and your agent starts a fresh conversation.' : 'The messages here are removed. Your agent still remembers the conversation.'}
      confirm={{ label: 'Clear', destructive: true, onClick: () => pick(more ? 'clear-fresh' : 'clear-mine') }}
      onCancel={close}
    >
      {ws ? <Checkbox checked={more} onChange={setMore} label="Start a fresh conversation" detail="Your agent forgets this one" /> : null}
    </Alert>
  );
}
