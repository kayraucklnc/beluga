import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoWorkspaces } from '../../src/demo.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** BLG-341: handing a worktree to a friend who isn't in your room, over the Beluga network. */

let net: Crowd | undefined;
const macs: Mac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('handing a worktree to a friend outside your room', () => {
  it('their Claude takes it over: the branch, the work in progress, the note and the chat; you follow along', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    // Kay has the same repository: a clone of ata's origin.
    const origin = git(project.root!, 'remote', 'get-url', 'origin');
    const clone = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-ho-kay-')), 'bob-api');
    git(os.tmpdir(), 'clone', '-q', origin, clone);
    kay.session.workspaces!.manager.addProject(clone);
    await kay.session.workspaces!.refresh();

    const ws = await ata.session.workspaces!.manager.createWorktree(project.id, 'add-auth');
    writeFileSync(path.join(ws.path, 'auth.ts'), 'export const requireUser = () => true;\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '-q', '-m', 'add requireUser');
    writeFileSync(path.join(ws.path, 'wip.ts'), '// half done\n');
    await ata.session.workspaces!.refresh();
    ata.session.sendChat('the session check is done', false, `ws:${ws.id}`);
    expect(kay.store.getState().peers.some((p) => p.peerId === ata.id)).toBe(false);

    expect(await ata.session.remote.handoff(ws.id, kay.id)).toBe(true);
    await settle(() => kay.store.getState().approvals.length > 0 || undefined);
    expect(kay.store.getState().approvals[0]!.title).toMatch(/^ata \(#[\w-]{6}\) wants to hand add-auth \(bob-api\) over to you$/);
    kay.session.answerApproval('yes');

    const theirs = await settle(() => kay.session.workspaces!.manager.list.flatMap((p) => p.workspaces).find((w) => w.handedFrom === 'ata'));
    expect(readFileSync(path.join(theirs.path, 'auth.ts'), 'utf8')).toContain('requireUser');
    expect(readFileSync(path.join(theirs.path, 'wip.ts'), 'utf8')).toContain('half done');
    const log = kay.session.workspaces!.manager.loadHistory<{ text: string }>(theirs.id);
    expect(log.some((l) => l.text.includes('Their note'))).toBe(true);
    expect(log.some((l) => l.text.includes('the session check is done'))).toBe(true);
    await settle(() => kay.runs.find((r) => r.prompt.includes('taking over this work from ata')));
    // Ata hears back, and follows along in Projects: it comes to them over the network too.
    await settle(() => ata.session.workspaces!.manager.find(ws.id)?.handedTo === 'kay' || undefined);
    await settle(() => ata.store.getState().sharedProjects.some((p) => p.worktrees.some((w) => w.id === theirs.id)) || undefined);
    // Its branch bundle never showed up as a folder kay shares with ata.
    expect(ata.store.getState().friendFolders).toEqual([]);
  }, 60_000);

  it('a decline comes back over the network too', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = await ata.session.workspaces!.manager.createWorktree(project.id, 'feature');
    await ata.session.workspaces!.refresh();
    expect(await ata.session.remote.handoff(ws.id, kay.id)).toBe(true);
    await settle(() => kay.store.getState().approvals.length > 0 || undefined);
    kay.session.answerApproval('no');
    await settle(() => ata.store.getState().log.find((l) => l.type === 'system' && l.text.includes("didn't take it over: declined")));
    expect(ata.session.workspaces!.manager.find(ws.id)?.handedTo).toBeUndefined();
  }, 60_000);
});
