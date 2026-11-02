import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Crowd, SLOW, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** BLG-205: a folder shared with a friend over the network shows in their Files, read-only, secrets never. */

let net: Crowd | undefined;
const macs: Mac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

function folder(name: string): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `beluga-folder-${name}-`)));
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'notes'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# Designs\nthe plan\n');
  writeFileSync(path.join(dir, 'notes', 'a.txt'), 'first note');
  writeFileSync(path.join(dir, '.env'), 'TOKEN=secret');
  return dir;
}

describe('a folder shared with a friend over the network', () => {
  it('shows in their Files under the owner, reads its files (never secrets), and goes when unshared', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata');
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const dir = folder('designs');
    // Share a Folder › Only… kay: no room needed.
    ata.session.shareFolder(dir, false, [kay.id]);
    const name = ata.store.getState().myShares.find((s) => s.root === dir)!.name;
    const shared = await settle(() => kay.store.getState().friendFolders.find((f) => f.name === name));
    expect(shared).toMatchObject({ owner: ata.id, ownerName: 'ata', label: 'designs', writable: false });
    // The top of Files: under ata's name.
    expect(kay.store.getState().browser.rows.find((r) => r.target !== 'up' && r.target.share === name)).toMatchObject({ label: 'ata · designs (read-only)', group: 'ata' });

    const at = { owner: ata.id, share: name, path: '' };
    const entries = await kay.session.listFiles(at);
    expect(entries.map((e) => e.name).sort()).toEqual(['README.md', 'notes']);
    expect((await kay.session.readFile({ ...at, path: 'README.md' })).content).toContain('the plan');
    expect((await kay.session.listFiles({ ...at, path: 'notes' })).map((e) => e.name)).toEqual(['a.txt']);
    await expect(kay.session.readFile({ ...at, path: '.env' })).rejects.toThrow();
    await expect(kay.session.readFile({ ...at, path: '../../etc/hosts' })).rejects.toThrow();

    // A folder ata shares with the room (everyone there) never reaches a friend this way.
    const open = folder('public');
    ata.session.shareFolder(open, false);
    const roomName = ata.store.getState().myShares.find((s) => s.root === open)!.name;
    await expect(kay.session.listFiles({ owner: ata.id, share: roomName, path: '' })).rejects.toThrow();

    ata.session.unshareFolder(name);
    await settle(() => !kay.store.getState().friendFolders.length);
    expect(kay.store.getState().browser.rows.some((r) => r.target !== 'up' && r.target.share === name)).toBe(false);
  }, 60_000 * SLOW);
});
