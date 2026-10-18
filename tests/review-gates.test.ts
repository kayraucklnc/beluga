import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SECRET_IN_COMMAND, decideTool } from '../src/agent/policy.js';
import { toolInside } from '../src/core/agent-host.js';
import { GuestShell, resolvePath } from '../src/core/guest-shell.js';
import type { People } from '../src/core/people.js';
import { DAY_MS, ProjectInvites, expiresIn, type GuestControl } from '../src/core/project-invites.js';
import { Store, initialState, type AppState } from '../src/core/store.js';
import type { WorkspaceSharing } from '../src/core/workspace-sharing.js';
import type { FsEntry, PeerInfo } from '../src/protocol.js';
import { findCandidates, resolverFor } from '../src/ui/links.js';

// Secret file names are built up so they never appear verbatim in this file.
const ENV = '.e' + 'nv';

describe('secret-command filter', () => {
  it('catches secret files named plainly, in paths, and with suffixes', () => {
    for (const cmd of [`cat ${ENV}`, `cat ./${ENV}`, `cat ${ENV}.local`, 'cat ~/.ssh/id_rsa', 'cat $HOME/.aws/credentials', `cat "${ENV}"`]) {
      expect(SECRET_IN_COMMAND.test(cmd), cmd).toBe(true);
    }
    expect(SECRET_IN_COMMAND.test('npm test')).toBe(false);
    expect(SECRET_IN_COMMAND.test('cat environment.ts')).toBe(false);
  });

  // BUG (src/agent/policy.ts:29): the terminator class is only [\s'"/]|$ and the prefix class only
  // ^|[\s'"/=], so shell punctuation right next to the name slips through. These reach a friend's
  // machine via run_on_peer (policy.ts:67, peer-run.ts:306), and for guests invited with "edit"
  // they run with no prompt at all (agent-host.ts:452 trusts that secrets were already refused,
  // and toolInside() passes relative names).
  it('catches secret names next to shell punctuation (; | < > & ( ) * ,)', () => {
    for (const cmd of [`cat ${ENV};`, `cat ${ENV}|base64`, `cat<${ENV}`, `cat ${ENV}>/tmp/x`, `cat ${ENV}&&ls`, `(cat ${ENV})`, `cat ${ENV}*`, 'tar c .ssh>x']) {
      expect(SECRET_IN_COMMAND.test(cmd), cmd).toBe(true);
    }
  });

  it('an edit-level guest cannot auto-run a command that pipes a secret file', () => {
    const cmd = `cat ${ENV}|base64`;
    // Neither gate stops it: the policy only asks, and the guest-edit shortcut then allows it.
    expect(decideTool('Bash', { command: cmd }, { cwd: '/p', roots: ['/p'], autoEdit: true })).toBe('deny');
    expect(toolInside('Bash', { command: cmd }, '/p')).toBe(false);
  });
});

describe('guest shell path scoping', () => {
  it('never resolves above the top of the share, whatever is typed', () => {
    for (const arg of ['..', '../..', '/../../etc', '~/../..', 'a/../../..', './../x/../..', '//..//..']) {
      expect(resolvePath('src/lib', arg).split('/')).not.toContain('..');
    }
    expect(resolvePath('src', '../../etc/passwd')).toBe('etc/passwd');
    expect(resolvePath('', '~')).toBe('');
  });

  function shellFixture(listing: Record<string, FsEntry[]>) {
    const ws = { owner: 'kay', id: 'w1', name: 'api', project: 'p', role: 'view' as const, share: 'ws-w1' };
    const store = new Store(initialState('test', 'ask'));
    store.dispatch({ type: 'shared_add', ws });
    const asked: string[] = [];
    const opened: string[] = [];
    const searched: Array<{ path: string; mode: string; q: string }> = [];
    const shell = new GuestShell({
      store,
      listFiles: async (at) => {
        asked.push(at.path);
        const entries = listing[at.path];
        if (!entries) throw new Error('not a folder');
        return entries;
      },
      openLocation: async (at) => void opened.push(at.path),
      search: async (at, mode, q) => {
        searched.push({ path: at.path, mode, q });
        return { hits: [{ path: 'src/a.ts', line: 3, text: 'hit' }], truncated: true };
      },
    });
    return { shell, store, asked, opened, searched, state: () => shell.state('w1') };
  }

  it('cd, ls, cat, grep only ever ask for paths inside the share', async () => {
    const f = shellFixture({ '': [{ name: 'src', dir: true, size: 0 }], src: [{ name: 'a.ts', dir: false, size: 1 }] });
    await f.shell.run('w1', 'cd src');
    expect(f.state().cwd).toBe('src');
    await f.shell.run('w1', 'cd ../../..');
    expect(f.state().cwd).toBe('');
    await f.shell.run('w1', 'cat ../../../etc/passwd');
    await f.shell.run('w1', 'ls /../..');
    await f.shell.run('w1', 'grep -i secret stuff');
    for (const p of [...f.asked, ...f.opened]) expect(p.split('/')).not.toContain('..');
    expect(f.opened).toEqual(['etc/passwd']);
    expect(f.searched).toEqual([{ path: '', mode: 'grep', q: 'secret stuff' }]);
    expect(f.state().entries.at(-1)!.out.at(-1)!.text).toMatch(/more results not shown/);
  });

  it('a failed cd keeps the folder, unknown commands are refused, clear empties the screen', async () => {
    const f = shellFixture({ '': [{ name: 'src', dir: true, size: 0 }] });
    await f.shell.run('w1', 'cd nope');
    expect(f.state().cwd).toBe('');
    expect(f.state().entries.at(-1)!.out[0]).toMatchObject({ tone: 'error', text: 'cd: not a folder' });
    await f.shell.run('w1', 'rm -rf /');
    expect(f.state().entries.at(-1)!.out[0]!.text).toMatch(/^rm: not available here/);
    await f.shell.run('w1', 'cat');
    expect(f.state().entries.at(-1)!.out[0]!.text).toBe('usage: cat <file>');
    await f.shell.run('w1', 'clear');
    expect(f.state().entries).toEqual([]);
    expect(f.state().busy).toBe(false);
    // Unknown workspace or blank line: nothing happens.
    await f.shell.run('nope', 'ls');
    await f.shell.run('w1', '   ');
    expect(f.state().entries).toEqual([]);
  });

  it('tree walks a few levels and clicking a folder lists it', async () => {
    const f = shellFixture({ '': [{ name: 'a', dir: true, size: 0 }, { name: 'r.md', dir: false, size: 1 }], a: [{ name: 'b', dir: true, size: 0 }], 'a/b': [{ name: 'c', dir: true, size: 0 }], 'a/b/c': [{ name: 'deep', dir: true, size: 0 }] });
    await f.shell.run('w1', 'tree');
    const tree = f.state().entries.at(-1)!.out.map((l) => l.text);
    expect(tree).toEqual(['/', '├── a/', '│   └── b/', '│       └── c/', '└── r.md']);
    await f.shell.openEntry('w1', 'a/b', true);
    expect(f.state().cwd).toBe('a/b');
    expect(f.state().entries.at(-1)!.out.map((l) => l.text)).toEqual(['c/']);
  });
});

describe('project link lifecycle (host side)', () => {
  function fixture() {
    let now = 1_000_000;
    const self: PeerInfo = { peerId: 'host', name: 'kay', shares: [], agent: true };
    const base = initialState('test', 'ask');
    const projects = [{ id: 'p1', name: 'api', workspaces: [{ id: 'w1', archived: false }, { id: 'w2', archived: true }] }] as unknown as AppState['projects'];
    const store = new Store({ ...base, self, projects, invite: 'https://x.trycloudflare.com#roomsecret' });
    const room = { setGate: vi.fn(), setAccess: vi.fn(), turnAway: vi.fn() } satisfies GuestControl;
    const sharing = { onChange: undefined, invite: vi.fn(), remove: vi.fn() } as unknown as WorkspaceSharing;
    const people = { setTrust: vi.fn(), forget: vi.fn() } as unknown as People;
    const toasts: string[] = [];
    const invites = new ProjectInvites({ store, selfId: () => 'host', sharing, people, room, toast: (t) => void toasts.push(t), system: () => undefined, copy: async () => undefined, now: () => now });
    const peers = (...ps: PeerInfo[]) => store.dispatch({ type: 'peers', peers: [self, ...ps] });
    return { store, room, sharing, people, toasts, invites, peers, tick: (ms: number) => (now += ms), state: store.getState };
  }
  const mia: PeerInfo = { peerId: 'mia', name: 'mia', shares: [], agent: true, guest: true };
  const zed: PeerInfo = { peerId: 'zed', name: 'zed', shares: [], agent: true, guest: true };

  it('a single-use link lets one person in; their reconnects at the door do not use it up', async () => {
    const f = fixture();
    const link = (await f.invites.create({ scope: 'p1', can: 'prompt', knock: true, singleUse: true, expiresInMs: DAY_MS }, { copy: false }))!;
    expect(f.invites.urlOf(link.id)).toMatch(/^https:\/\/x\.trycloudflare\.com#/);
    expect(f.invites.urlOf(link.id)).not.toContain('roomsecret');
    expect(f.invites.admit(link.id, 'mia', false)).toMatchObject({ full: false, contacts: [] });
    expect(f.invites.admit(link.id, 'mia', false)).toBeDefined();
    expect(f.state().links[0]!.used).toBe(1);
    expect(f.invites.admit(link.id, 'zed', false)).toBeUndefined();
    expect(f.invites.isRestricted('mia')).toBe(true);
  });

  it('expired, unknown, closed-room and own-id admissions are refused', async () => {
    const f = fixture();
    const link = (await f.invites.create({ scope: 'room', can: 'watch', knock: false, singleUse: false, expiresInMs: 60_000 }, { copy: false }))!;
    expect(f.invites.admit('nope', 'mia', false)).toBeUndefined();
    expect(f.invites.admit(link.id, 'mia', true)).toBeUndefined();
    expect(f.invites.admit(link.id, 'host', false)).toBeUndefined();
    expect(expiresIn(f.state().links[0]!.expiresAt, 1_000_000)).toBe('expires in 1 min');
    f.tick(60_000);
    expect(f.invites.admit(link.id, 'mia', false)).toBeUndefined();
    expect(f.state().links[0]!.used).toBe(0);
  });

  it('revoking a link drops its key and turns away whoever is knocking with it', async () => {
    const f = fixture();
    const link = (await f.invites.create({ scope: 'p1', can: 'edit', knock: true, singleUse: false, expiresInMs: 0 }, { copy: false }))!;
    const gate = f.room.setGate.mock.calls[0]![0] as { keys: () => Array<{ id: string }> };
    expect(gate.keys().map((k) => k.id)).toEqual([link.id]);
    f.invites.admit(link.id, 'mia', false);
    f.peers(mia);
    f.invites.onPeers([mia]);
    expect(f.state().knocks.map((k) => k.peerId)).toEqual(['mia']);
    f.invites.revoke(link.id);
    expect(gate.keys()).toEqual([]);
    expect(f.state().links).toEqual([]);
    expect(f.state().knocks).toEqual([]);
    expect(f.room.turnAway).toHaveBeenCalledWith('mia');
    expect(f.invites.urlOf(link.id)).toBeUndefined();
    expect(f.invites.admit(link.id, 'zed', false)).toBeUndefined();
    // Letting someone in after the link is gone does nothing.
    f.invites.letIn('mia');
    expect(f.state().guests.mia).toBeUndefined();
  });

  it('letting in grants only the project, with less than offered if asked; edit stays in its live workspaces', async () => {
    const f = fixture();
    const link = (await f.invites.create({ scope: 'p1', can: 'edit', knock: true, singleUse: true, expiresInMs: DAY_MS }, { copy: false }))!;
    f.invites.admit(link.id, 'mia', false);
    f.peers(mia);
    f.invites.letIn('mia', 'watch');
    expect(f.state().guests.mia).toMatchObject({ projects: ['p1'], room: false, can: 'watch' });
    expect(f.people.setTrust).toHaveBeenCalledWith('mia', 'blocked', true);
    expect(f.sharing.invite).toHaveBeenCalledTimes(1);
    expect(f.sharing.invite).toHaveBeenCalledWith('w1', 'mia', 'view', { quiet: true, can: 'watch' });
    expect(f.invites.canEditIn('mia', 'ws:w1')).toBe(false);
    f.invites.change('mia', { can: 'edit' });
    expect(f.invites.canEditIn('mia', 'ws:w1')).toBe(true);
    expect(f.invites.canEditIn('mia', 'ws:w2')).toBe(false); // archived
    expect(f.invites.canEditIn('mia', 'room')).toBe(false);
    expect(f.invites.canEditIn('zed', 'ws:w1')).toBe(false);
    // Reconnecting as a guest doesn't need (or use) the link.
    expect(f.invites.admit('gone', 'mia', false)).toMatchObject({ full: false });
    f.invites.remove('mia');
    expect(f.state().guests.mia).toBeUndefined();
    expect(f.room.turnAway).toHaveBeenCalledWith('mia');
  });

  it('links without knocking let people straight in; non-guests at the door are ignored', async () => {
    const f = fixture();
    const link = (await f.invites.create({ scope: 'room', can: 'prompt', knock: false, singleUse: false, expiresInMs: 0 }, { copy: false }))!;
    f.invites.admit(link.id, 'mia', false);
    f.invites.admit(link.id, 'zed', false);
    const member = { ...zed, guest: false };
    f.peers(mia, member);
    f.invites.onPeers([mia, member]);
    expect(f.state().guests.mia).toMatchObject({ room: true, can: 'prompt' });
    expect(f.state().guests.zed).toBeUndefined();
    expect(f.invites.isRestricted('mia')).toBe(false);
  });

  it('without a hosted room no link is made', async () => {
    const store = new Store(initialState('test', 'ask'));
    const toasts: string[] = [];
    const invites = new ProjectInvites({ store, selfId: () => 'me', sharing: {} as WorkspaceSharing, people: {} as People, toast: (t) => void toasts.push(t), system: () => undefined, copy: async () => undefined });
    expect(invites.available).toBe(false);
    expect(await invites.create({ scope: 'room', can: 'watch', knock: true, singleUse: true, expiresInMs: 0 })).toBeUndefined();
    expect(toasts[0]).toMatch(/rooms you host/);
  });
});

describe('link detection edge cases', () => {
  it('keeps trailing punctuation and brackets out of links', () => {
    const vals = (t: string) => findCandidates(t).map((c) => c.value);
    expect(vals('see https://example.com/a?b=1).')).toEqual(['https://example.com/a?b=1']);
    expect(vals('edit src/app.ts:42, then README.md.')).toEqual(['src/app.ts', 'README.md']);
    expect(findCandidates('src/app.ts#L7')[0]).toMatchObject({ value: 'src/app.ts', line: 7 });
    expect(vals('version v1.2.3 or 3.14 or @bob')).toEqual([]);
  });

  it("a friend's paths never escape their shares, and attachment links can't name other folders", () => {
    const state: AppState = { ...initialState('test', 'ask'), self: { peerId: 'me', name: 'me', shares: [], agent: true }, peers: [{ peerId: 'bob', name: 'bob', shares: [{ name: 'proj', writable: false }], agent: true }] } as AppState;
    const item = { type: 'chat', from: 'bob', channel: 'room', text: '', ts: 0 } as unknown as Parameters<typeof resolverFor>[1];
    const resolve = resolverFor(state, item, () => ({ dir: false }))!;
    const path = (value: string) => resolve({ kind: 'path', start: 0, end: value.length, value });
    expect(path('proj/src/a.ts')).toMatchObject({ kind: 'peer', owner: 'bob', share: 'proj', path: 'src/a.ts' });
    expect(path('proj/../../etc/passwd')).toBeUndefined();
    expect(path('/etc/passwd')).toBeUndefined();
    expect(path('~/notes.md')).toBeUndefined();
    expect(path('other/a.ts')).toBeUndefined();
    expect(resolve({ kind: 'href', value: 'klaud-attachment:bob/a.png' })).toMatchObject({ kind: 'attachment', owner: 'bob', file: 'a.png' });
    expect(resolve({ kind: 'href', value: 'klaud-attachment:bob/..' })).toBeUndefined();
    expect(resolve({ kind: 'href', value: 'javascript:alert(1)' })).toBeUndefined();
  });
});

describe('guest runs', () => {
  it('never reach the room tools, even the always-allowed ones', () => {
    const ctx = { cwd: '/p', roots: ['/p'], autoEdit: true, guest: true };
    for (const tool of ['send_chat', 'list_peers', 'read_peer_file', 'list_peer_files', 'run_on_peer', 'ask_agent']) expect(decideTool(`mcp__klaud__${tool}`, {}, ctx), tool).toBe('deny');
    expect(decideTool('mcp__klaud__list_peers', {}, { ...ctx, guest: false })).toBe('allow');
  });

  it('an edit guest cannot follow a symlink out of the project', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-guest-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-out-'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(toolInside('Write', { file_path: 'link/x.txt' }, root)).toBe(false);
    expect(toolInside('Write', { file_path: 'new/dir/x.txt' }, root)).toBe(true);
  });
});

describe("a friend's command", () => {
  it('gets only basic environment variables, never tokens', async () => {
    const { baseEnv } = await import('../src/core/peer-run.js');
    process.env.KLAUD_TEST_TOKEN = 'sekret';
    const env = baseEnv();
    delete process.env.KLAUD_TEST_TOKEN;
    expect(env.PATH).toBeTruthy();
    expect(Object.values(env)).not.toContain('sekret');
  });
});
