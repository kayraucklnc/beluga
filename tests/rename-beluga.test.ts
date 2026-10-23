import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { belugaEnv, belugaEnvBoth } from '../src/core/beluga-env.js';
import { belugaHome, migrateHome } from '../src/core/home.js';
import { RENAME_NOTE, renameNote } from '../src/core/rename-note.js';
import { tilde } from '../src/core/paths.js';
import { isSecretPath } from '../src/core/shares.js';
import { renamedActors } from '../src/core/board/model.js';
import { decodeInvite, encodeInvite, findInvite } from '../src/net/invite.js';
import { codeLinkOf, linkOf, parseTicket } from '../src/net/mesh/invitations.js';
import { isGraphFence } from '../src/shared/graph-spec.js';
import { humanizeTool } from '../src/shared/step-titles.js';
import { encodeKey } from '../src/net/p2p.js';

/** Klaud → Beluga: everything already in the world keeps working (KLD-60). */

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-rename-')));

describe('the home folder moves from ~/.klaud to ~/.beluga', () => {
  it('renames a real ~/.klaud, leaves a link back, and is idempotent', () => {
    const home = tmp();
    mkdirSync(path.join(home, '.klaud', 'workspaces'), { recursive: true });
    writeFileSync(path.join(home, '.klaud', 'settings.json'), '{"name":"kay"}');
    expect(migrateHome(home)).toBe(path.join(home, '.beluga'));
    expect(lstatSync(path.join(home, '.beluga')).isDirectory()).toBe(true);
    expect(lstatSync(path.join(home, '.klaud')).isSymbolicLink()).toBe(true);
    // Old paths (saved projects, git's worktree links) still reach the same files.
    expect(readFileSync(path.join(home, '.klaud', 'settings.json'), 'utf8')).toBe('{"name":"kay"}');
    // Again: nothing changes.
    expect(migrateHome(home)).toBe(path.join(home, '.beluga'));
    expect(readlinkSync(path.join(home, '.klaud'))).toBe(path.join(home, '.beluga'));
    expect(readFileSync(path.join(home, '.beluga', 'settings.json'), 'utf8')).toBe('{"name":"kay"}');
  });

  it('follows ~/.klaud → ~/.klaude (the first rename): the real folder moves, both old names still work', () => {
    const home = tmp();
    mkdirSync(path.join(home, '.klaude'));
    writeFileSync(path.join(home, '.klaude', 'identity.json'), 'id');
    symlinkSync(path.join(home, '.klaude'), path.join(home, '.klaud'), 'dir');
    expect(migrateHome(home)).toBe(path.join(home, '.beluga'));
    expect(lstatSync(path.join(home, '.beluga')).isDirectory()).toBe(true);
    for (const old of ['.klaud', '.klaude']) expect(readFileSync(path.join(home, old, 'identity.json'), 'utf8')).toBe('id');
  });

  it('a home kept elsewhere (a link out of ~) stays there: ~/.beluga links to it', () => {
    const home = tmp();
    const elsewhere = tmp();
    writeFileSync(path.join(elsewhere, 'settings.json'), '{}');
    symlinkSync(elsewhere, path.join(home, '.klaud'), 'dir');
    expect(migrateHome(home)).toBe(path.join(home, '.beluga'));
    expect(realpathSync(path.join(home, '.beluga'))).toBe(elsewhere);
    expect(existsSync(path.join(elsewhere, 'settings.json'))).toBe(true);
  });

  it('starts fresh without an old home, and never touches an existing ~/.beluga', () => {
    const home = tmp();
    expect(migrateHome(home)).toBe(path.join(home, '.beluga'));
    expect(existsSync(path.join(home, '.beluga'))).toBe(false);
    mkdirSync(path.join(home, '.beluga'));
    mkdirSync(path.join(home, '.klaud'));
    expect(migrateHome(home)).toBe(path.join(home, '.beluga'));
    expect(lstatSync(path.join(home, '.klaud')).isDirectory()).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('when it cannot move, it keeps using the old folder', () => {
    const home = tmp();
    mkdirSync(path.join(home, '.klaud'));
    chmodSync(home, 0o555);
    try {
      expect(migrateHome(home)).toBe(path.join(home, '.klaud'));
      expect(lstatSync(path.join(home, '.klaud')).isDirectory()).toBe(true);
    } finally {
      chmodSync(home, 0o755);
    }
  });

  describe('BELUGA_HOME, with KLAUD_HOME still honoured', () => {
    const saved = { b: process.env.BELUGA_HOME, k: process.env.KLAUD_HOME };
    afterEach(() => {
      for (const [key, value] of [['BELUGA_HOME', saved.b], ['KLAUD_HOME', saved.k]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('reads BELUGA_HOME first, then KLAUD_HOME', () => {
      process.env.BELUGA_HOME = '/tmp/b';
      process.env.KLAUD_HOME = '/tmp/k';
      expect(belugaHome()).toBe('/tmp/b');
      delete process.env.BELUGA_HOME;
      expect(belugaHome()).toBe('/tmp/k');
    });
  });
});

describe('environment variables', () => {
  it('BELUGA_* first, KLAUD_* as a fallback', () => {
    expect(belugaEnv('GH', { BELUGA_GH: 'new', KLAUD_GH: 'old' })).toBe('new');
    expect(belugaEnv('GH', { KLAUD_GH: 'old' })).toBe('old');
    expect(belugaEnv('GH', {})).toBeUndefined();
    expect(belugaEnvBoth('WORKTREE', '/w')).toEqual({ BELUGA_WORKTREE: '/w', KLAUD_WORKTREE: '/w' });
  });
});

describe('paths and secrets', () => {
  it('shows the old homes as ~/.beluga', () => {
    expect(tilde('/Users/kay/.klaud/workspaces/x', '/Users/kay')).toBe('~/.beluga/workspaces/x');
    expect(tilde('/Users/kay/.klaude/workspaces/x', '/Users/kay')).toBe('~/.beluga/workspaces/x');
    expect(tilde('/Users/kay/.klaudette', '/Users/kay')).toBe('~/.klaudette');
  });

  it('keeps Beluga’s own files secret under every name of its home', () => {
    const home = process.env.HOME ?? '~';
    for (const name of ['.beluga', '.klaud', '.klaude']) {
      expect(isSecretPath(path.join(home, name, 'identity.json'))).toBe(true);
      expect(isSecretPath(path.join(home, name, 'workspaces', 'app', 'README.md'))).toBe(false);
    }
  });
});

describe('the one-time note for `klaud`', () => {
  it('shows once to someone starting it as klaud, never as beluga', () => {
    const home = tmp();
    expect(renameNote('/usr/local/bin/beluga', home)).toBeUndefined();
    expect(renameNote('/usr/local/bin/klaud', home)).toBe(RENAME_NOTE);
    expect(renameNote('/usr/local/bin/klaud', home)).toBeUndefined();
  });
});

describe('links', () => {
  const key = encodeKey(Buffer.alloc(32, 7));
  const secret = 'tVh65bTGibnD1mD3ofr75-PD';

  it('new room invites use beluga://, and klaud:// ones still open', () => {
    const link = encodeInvite({ url: `p2p://${key}`, secret });
    expect(link).toBe(`beluga://${key}#${secret}`);
    expect(decodeInvite(link)).toEqual({ url: `p2p://${key}`, secret });
    expect(decodeInvite(`klaud://${key}#${secret}`)).toEqual({ url: `p2p://${key}`, secret });
    expect(findInvite(`klaud join klaud://${key}#${secret}`)).toBe(`klaud://${key}#${secret}`);
    expect(findInvite(`beluga join ${link}`)).toBe(link);
  });

  it('friend and group invitations: beluga:// made, both read', () => {
    const s = 'AAAAAAAAAAAAAAAAAAAAAA';
    expect(linkOf({ kind: 'friend', secret: s })).toBe(`beluga://add#${s}`);
    expect(codeLinkOf({ kind: 'group', code: 'K7QM4XPAR2TD' })).toBe('beluga://join?code=K7QM-4XPA-R2TD');
    for (const scheme of ['beluga', 'klaud']) {
      expect(parseTicket(`${scheme}://add#${s}`)).toEqual({ via: 'link', secret: s });
      expect(parseTicket(`${scheme}://join?code=K7QM-4XPA-R2TD`)).toEqual({ via: 'code', code: 'K7QM4XPAR2TD' });
    }
  });
});

describe('what was saved before the rename', () => {
  it("reads stored { kind: 'klaud' } actors as Beluga, everywhere, and nothing else", () => {
    const saved = {
      issues: [{ activity: [{ by: { kind: 'klaud' }, kind: 'status' }], proof: [{ kind: 'image', by: { kind: 'klaud' } }] }],
      other: { kind: 'klaud', extra: 1 },
    };
    expect(renamedActors(saved)).toEqual({
      issues: [{ activity: [{ by: { kind: 'beluga' }, kind: 'status' }], proof: [{ kind: 'image', by: { kind: 'beluga' } }] }],
      other: { kind: 'klaud', extra: 1 },
    });
    expect(saved.issues[0]!.activity[0]!.by.kind).toBe('klaud');
  });

  it('draws graphs tagged either way, and titles steps of the old MCP servers', () => {
    expect(isGraphFence('beluga-graph')).toBe(true);
    expect(isGraphFence('klaud-graph')).toBe(true);
    expect(isGraphFence('mermaid')).toBe(false);
    for (const server of ['beluga', 'klaud']) expect(humanizeTool(`mcp__${server}__send_chat`, { message: 'hi' })).toEqual(humanizeTool('mcp__beluga__send_chat', { message: 'hi' }));
    expect(JSON.stringify(humanizeTool('mcp__klaud_board__task_get', {}))).not.toContain('klaud');
  });
});
