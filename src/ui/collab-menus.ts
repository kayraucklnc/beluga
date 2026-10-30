import { type AppState, peerName } from '../core/store.js';
import type { MenuOption, MenuSpec } from './menus.js';

const others = (state: AppState) => state.peers.filter((p) => p.peerId !== state.self?.peerId);
const findWs = (state: AppState, id: string) => state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);

/** "Share" on a workspace: who's in it, invite people from the room, or bring someone new. */
export function wsShareMenu(state: AppState, wsId: string): MenuSpec | undefined {
  const ws = findWs(state, wsId);
  if (!ws) return undefined;
  const members = state.members[wsId] ?? {};
  const people = others(state);
  const options: MenuOption[] = [];
  for (const p of people) {
    const role = members[p.peerId];
    if (role === 'contribute') {
      options.push({ id: `ws-view:${p.peerId}`, label: `${p.name}: switch to follow-only`, hint: 'now: can ask your agent here' });
      options.push({ id: `ws-remove:${p.peerId}`, label: `Remove ${p.name}`, hint: 'they lose the chat and the files' });
    } else if (role === 'view') {
      options.push({ id: `ws-contribute:${p.peerId}`, label: `Let ${p.name} work here too`, hint: 'now: following along' });
      options.push({ id: `ws-remove:${p.peerId}`, label: `Remove ${p.name}`, hint: 'they lose the chat and the files' });
    } else {
      options.push({ id: `ws-contribute:${p.peerId}`, label: `Invite ${p.name} to work here`, hint: 'chat, ask your agent, see the files' });
      options.push({ id: `ws-view:${p.peerId}`, label: `Let ${p.name} follow along`, hint: 'read-only: chat history and files' });
    }
  }
  options.push({ id: 'ws-link', label: 'Invite someone by link…', hint: 'to this project (all its worktrees and chats); they knock first' });
  options.push({ id: 'invite', label: state.invite ? 'Copy the room invite for someone new' : 'Invite someone new to the room', hint: 'then share this workspace with them here' });
  options.push({ id: 'close', label: 'Done', hint: 'Esc' });
  const inside = Object.entries(members).map(([id, role]) => `${peerName(state, id)} (${role === 'contribute' ? 'working here' : 'following'})`);
  return {
    title: `Share ${ws.name}`,
    intro: [
      inside.length ? `In this workspace: ${inside.join(', ')}` : 'Only you are in this workspace.',
      'People you invite see this conversation and can browse its folder. If they can work here, they can ask your',
      'Your agent too: it runs on your computer, and risky steps still ask you (unless you fully trust them).',
      ...(people.length ? [] : ['', 'Nobody else is in the room. To share just this worktree with a friend, type /invite @their-name in its chat.']),
    ],
    options,
  };
}

/** The ⋯ on a workspace someone shared with you. */
export function sharedMenu(state: AppState, owner: string, id: string): MenuSpec | undefined {
  const w = state.shared.find((x) => x.owner === owner && x.id === id);
  if (!w) return undefined;
  return {
    title: `${peerName(state, owner)}'s ${w.name}`,
    intro: [w.role === 'contribute' ? `You can talk to ${peerName(state, owner)}'s agent here. It runs on their computer.` : 'You are following along (read-only).'],
    options: [
      { id: 'sh-chat', label: 'Open the chat', hint: '' },
      { id: 'sh-files', label: 'Browse the files', hint: '' },
      { id: 'sh-leave', label: `Leave ${w.name}`, hint: `${peerName(state, owner)} can invite you again` },
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}

/** Clear a conversation: what it means here, spelled out. */
export function clearMenu(state: AppState, channel: string, isHost: boolean): MenuSpec {
  if (channel === 'room') {
    return {
      title: 'Clear the group chat?',
      intro: [isHost ? 'You host this room, so you can clear it for everyone (and for people who join later).' : 'This clears it on your screen. Only the host can clear it for everyone.'],
      options: [
        ...(isHost ? [{ id: 'clear-everyone', label: 'Clear for everyone', hint: 'also forgets what newcomers would see' }] : []),
        { id: 'clear-mine', label: 'Clear on my screen', hint: '' },
        { id: 'close', label: 'Cancel', hint: 'Esc' },
      ],
    };
  }
  const ws = findWs(state, channel.slice(3));
  return {
    title: `Clear ${ws?.name ?? 'this conversation'}?`,
    intro: ['Clearing removes the messages here. Your agent can keep remembering the conversation, or start fresh.'],
    options: [
      { id: 'clear-mine', label: 'Clear messages', hint: 'your agent still remembers' },
      ...(ws ? [{ id: 'clear-fresh', label: 'Clear and start a fresh conversation', hint: 'your agent forgets this one' }] : []),
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}

/** From a person: put them into one of your workspaces. */
export function invitePersonMenu(state: AppState, peerId: string): MenuSpec | undefined {
  const peer = state.peers.find((p) => p.peerId === peerId);
  if (!peer) return undefined;
  const list = state.projects.flatMap((p) => p.workspaces.filter((w) => !w.archived && !w.external).map((w) => ({ w, p })));
  return {
    title: `Invite ${peer.name} into…`,
    intro: [`${peer.name} will see the conversation and files, and can ask your agent there.`],
    options: [
      ...list.slice(0, 30).map(({ w, p }) => ({
        id: `inv:${w.id}`,
        label: `${p.root ? `${p.name} › ` : ''}${w.name}`,
        hint: state.members[w.id]?.[peerId] ? 'already in' : w.kind === 'chat' ? 'chat' : w.kind === 'main' ? 'main folder' : 'worktree',
      })),
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}
