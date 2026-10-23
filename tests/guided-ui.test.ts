import { describe, expect, it } from 'vitest';
import { type AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import type { PeerInfo } from '../src/protocol.js';
import { actionButtons, buttonLabel } from '../src/ui/actions.js';
import { menuSpec, personMenu, welcomeMenu } from '../src/ui/menus.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [{ name: 'app', writable: true }] },
  { peerId: 'b', name: 'bob', agent: true, shares: [{ name: 'api', writable: false }] },
  { peerId: 'c', name: 'cat', agent: false, shares: [] },
];
const room = (): AppState => reduce(reduce(initialState("kay's room"), { type: 'peers', peers }), { type: 'welcome', self: peers[0]! });

describe('menus', () => {
  it('welcomes you and asks who can use your Claude', () => {
    const spec = welcomeMenu(room());
    expect(spec.title).toBe("Welcome to kay's room");
    expect(spec.intro[0]).toBe("You're kay. bob, cat are here.");
    expect(spec.options.map((o) => o.id)).toEqual(['share-ask', 'share-auto', 'share-deny']);
    const alone = reduce(room(), { type: 'peers', peers: [peers[0]!] });
    expect(welcomeMenu(alone).intro[0]).toContain('Nobody else is here yet');
  });

  it('offers actions for a friend', () => {
    const levels = ['trust:blocked', 'trust:ask', 'trust:trusted', 'trust:full'];
    const spec = personMenu(room(), 1)!;
    expect(spec.options.map((o) => o.id)).toEqual([...levels, 'ask', 'person-invite-ws', 'person-share', 'follow', 'browse']);
    expect(spec.options.find((o) => o.id === 'trust:ask')?.label).toBe('◉ Ask me each time');
    const followed = reduce(reduce(room(), { type: 'follow', peerId: 'b' }), { type: 'trust', peerId: 'b', trusted: true });
    expect(personMenu(followed, 1)!.options.map((o) => o.id)).toEqual([...levels, 'ask', 'person-invite-ws', 'person-share', 'unfollow', 'browse']);
    expect(personMenu(followed, 1)!.options.find((o) => o.id === 'trust:trusted')?.label).toBe('◉ Trusted');
    expect(personMenu(reduce(room(), { type: 'full_trust', peerId: 'b', trusted: true }), 1)!.intro.join(' ')).toContain('Now: Full trust');
    expect(personMenu(room(), 2)!.options.map((o) => o.id)).toEqual([...levels, 'person-invite-ws', 'person-share', 'follow']); // no Claude, no shares
    const offering = reduce(room(), { type: 'peers', peers: peers.map((p) => (p.peerId === 'b' ? { ...p, projects: ['api'] } : p)) });
    expect(personMenu(offering, 1)!.options.map((o) => o.id)).toContain('person-remote-ws');
    expect(personMenu(room(), 9)).toBeUndefined();
  });

  it('offers your own actions', () => {
    expect(personMenu(room(), 0)!.options.map((o) => o.id)).toEqual(['ask-self', 'share-folder', 'leave-room', 'sharing', 'settings']);
    const withInvite = reduce(room(), { type: 'invite', invite: 'https://x#y' });
    expect(menuSpec(withInvite, { kind: 'person', index: 0 })!.options.map((o) => o.id)).toEqual(['ask-self', 'share-folder', 'invite', 'leave-room', 'sharing', 'settings']);
    expect(menuSpec(room(), { kind: 'settings' })!.options.map((o) => o.id)).toEqual(['set-name', 'set-theme', 'sec:people', 'sec:notify', 'sec:claude', 'sec:workspaces', 'sec:display', 'close']);
    expect(menuSpec(room(), { kind: 'settings', section: 'people' })!.options.map((o) => o.id)).toEqual(['p-default', 'p-person:b', 'p-person:c', 'set-tunnel', 'set-back']);
    expect(menuSpec(room(), { kind: 'settings', section: 'notify' })!.options.map((o) => o.id)).toContain('n-desktop');
    expect(menuSpec(room(), { kind: 'settings', section: 'display' })!.options.map((o) => o.id)).toEqual(['set-mouse', 'd-context', 'd-subagents', 'size-in', 'size-out', 'size-reset', 'set-back']);
    expect(menuSpec(room(), { kind: 'welcome' })?.title).toContain('Welcome');
  });
});

describe('action bar', () => {
  it('shows what you can do in each panel', () => {
    const s = room();
    expect(actionButtons('chat', s, false).map((b) => b.id)).toEqual(['ask', 'commands', 'projects', 'invite', 'share-folder', 'clear', 'settings', 'help']);
    expect(actionButtons('chat', s, false).find((b) => b.id === 'invite')?.text).toBe('Invite friends');
    expect(actionButtons('chat', reduce(s, { type: 'view', view: { kind: 'workspace', id: 'w', tab: 'chat' } }), false).map((b) => b.id)).toEqual(['actions', 'review', 'terminal', 'templates', 'overview', 'clear', 'settings', 'help']);
    expect(actionButtons('terminal', s, false).map((b) => b.id)).toEqual(['chat', 'scroll']);
    expect(actionButtons('chat', reduce(s, { type: 'view', view: { kind: 'search' } }), false).map((b) => b.id)).toEqual(['scroll', 'open-hit', 'overview', 'help']);
    expect(actionButtons('projects', s, false).map((b) => b.id)).toEqual(['open-project-item', 'overview', 'chat']);
    expect(actionButtons('main', s, false).map((b) => b.id)).toContain('review-claude');
    expect(actionButtons('main', reduce(s, { type: 'view', view: { kind: 'overview' } }), false).map((b) => b.id)).toEqual(['scroll', 'chat']);
    expect(actionButtons('chat', reduce(s, { type: 'invite', invite: 'x' }), false).find((b) => b.id === 'invite')?.text).toBe('Copy invite');
    expect(actionButtons('chat', s, true).map((b) => b.id)).toEqual(['accept', 'hide']);
    expect(actionButtons('people', s, false).map((b) => b.id)).toEqual(['menu', 'chat']);
    expect(actionButtons('viewer', s, false).map((b) => b.text)).toEqual(['Scroll', 'Back to chat']);
    expect(actionButtons('viewer', s, false, { full: true, raw: false }).map((b) => b.text)).toEqual(['Scroll', 'Leave fullscreen']);
    expect(actionButtons('files', s, false).map((b) => b.id)).toEqual(['open', 'chat']);
    const at = { owner: 'b', share: 'api', path: '' };
    const inFolder = reduce(reduce(s, { type: 'browser_loading', at }), { type: 'browser_entries', at, entries: [{ name: 'a.md', dir: false, size: 1 }] });
    const onFile = reduce(inFolder, { type: 'browser_cursor', delta: 1 });
    expect(actionButtons('files', onFile, false).map((b) => b.id)).toEqual(['open', 'download', 'up', 'chat']);
    expect(buttonLabel({ id: 'x', text: 'Help', key: '' })).toBe('Help');
  });
});
