import { describe, expect, it } from 'vitest';
import { type AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import { actionButtons } from '../src/ui/actions.js';
import { renderLog } from '../src/ui/format.js';
import { copyIndex, guestAddMenu, guestPersonMenu, inviteChoice, inviteMenu } from '../src/ui/invite-menus.js';
import { menuSpec, personMenu, projectMenu } from '../src/ui/menus.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const text = (lines: readonly (readonly { text: string }[])[]) => lines.map((l) => l.map((s) => s.text).join(''));
const ws: Workspace = { id: 'w1', projectRoot: '/p', name: 'add-auth', path: '/wt', kind: 'worktree', branch: 'add-auth', createdAt: 1, projectId: 'p1', external: false };
const projects: Project[] = [
  { id: 'p1', name: 'bob-api', root: '/p', base: 'origin/main', workspaces: [ws] },
  { id: 'p2', name: 'landing', root: '/l', base: 'origin/main', workspaces: [] },
];
const me = { peerId: 'me', name: 'kay', shares: [], agent: true, host: true };
const mia = { peerId: 'm', name: 'mia', shares: [], agent: false, guest: true };

function room(): AppState {
  let s = reduce(initialState('r'), { type: 'projects', projects });
  s = reduce(s, { type: 'welcome', self: me });
  return reduce(s, { type: 'peers', peers: [me, mia] });
}

const link = { id: 'L1', scope: 'p1', label: 'bob-api', can: 'prompt' as const, knock: true, singleUse: true, createdAt: 0, used: 1, expiresAt: Date.now() + 121 * 60_000 };

describe('the Invite flow', () => {
  it('opened from a project: this project, prompt, knock, one person, 24h; Enter copies', () => {
    const spec = inviteMenu(room(), inviteChoice('p1'), true);
    const labels = spec.options.map((o) => o.label);
    expect(labels[0]).toMatch(/Invite to\s+◉ This project · bob-api/);
    expect(labels[1]).toMatch(/○ Everything/);
    expect(labels.find((l) => l.includes('Prompt'))).toContain('◉');
    expect(labels.filter((l) => l.includes('☑'))).toHaveLength(3);
    expect(spec.options[copyIndex(spec)]?.id).toBe('il-copy');
    expect(spec.options[copyIndex(spec)]?.hint).toBe('bob-api · can prompt · knocks first');
  });

  it('opened from anywhere else offers everything first, then your projects', () => {
    const ids = inviteMenu(room(), inviteChoice(), true).options.map((o) => o.id);
    expect(ids.slice(0, 3)).toEqual(['il-scope:room', 'il-scope:p1', 'il-scope:p2']);
  });

  it('lists your links to turn off, and only the host can make them', () => {
    const s = reduce(room(), { type: 'link_set', link });
    expect(inviteMenu(s, inviteChoice('p1'), true).options.find((o) => o.id === 'il-revoke:L1')?.hint).toMatch(/expires in 2h · used by 1 · one person/);
    expect(inviteMenu(s, inviteChoice('p1'), false).options.map((o) => o.id)).toEqual(['close']);
  });

  it('is reachable from a project, People (you), and the bottom bar when hosting', () => {
    expect(projectMenu(room(), 'p1')!.options.map((o) => o.id)).toContain('p-invite');
    expect(personMenu(room(), 0)!.options.map((o) => o.id)).toContain('invite-menu');
    expect(actionButtons('chat', room(), false).find((b) => b.id === 'invite')?.text).toBe('Invite…');
    expect(menuSpec(room(), { kind: 'invite_link', ...inviteChoice('p1') })?.title).toBe('Invite someone');
  });
});

describe('guests in People', () => {
  const guest = { peerId: 'm', name: 'mia', projects: ['p1'], room: false, can: 'prompt' as const };

  it('shows what they are in and lets you change it without a new link', () => {
    const s = reduce(room(), { type: 'guest_set', peerId: 'm', guest });
    const spec = personMenu(s, 1)!;
    expect(spec.intro[0]).toBe('mia · bob-api · can prompt');
    expect(spec.options.map((o) => o.id)).toEqual(['g-can:watch', 'g-can:prompt', 'g-can:edit', 'g-add', 'g-room', 'g-remove', 'close']);
    expect(guestPersonMenu(s, { ...guest, room: true }).options.map((o) => o.id)).not.toContain('g-room');
    expect(guestAddMenu(s, 'm')!.options.map((o) => o.hint)).toEqual(['already in', '', 'Esc']);
  });
});

describe('prompts from someone else', () => {
  it('are attributed to them, via the Claude that ran them', () => {
    const lines = text(renderLog([{ type: 'agent', id: 'a', requestId: 'r', owner: 'me', ownerName: 'kay', requester: 'm', requesterName: 'mia', prompt: 'fix it', status: 'done', text: 'done', steps: [], subagents: [], ts: 0, channel: 'ws:w1' } as never], 80));
    expect(lines[0]).toContain("◆ mia (via kay's Claude)");
  });
});
