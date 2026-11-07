import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchSchedules } from '../../src/core/schedule/launch.js';
import { schedulesOf } from '../../src/core/schedule/registry.js';
import { saveSettings } from '../../src/core/settings.js';
import { createDemoWorkspaces } from '../../src/demo.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** The list of a chat's schedules also reaches a friend who follows it over the network. */

const EVERY_FIVE = { title: 'Check', prompt: 'Look', when: { kind: 'interval', minutes: 5 } } as const;

let net: Crowd | undefined;
const macs: Mac[] = [];
const stops: Array<() => void> = [];
const homeBefore = process.env.BELUGA_HOME;

beforeEach(() => {
  process.env.BELUGA_HOME = mkdtempSync(path.join(os.tmpdir(), 'beluga-fs-schedules-'));
  saveSettings({ chatSchedules: true });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
  process.env.BELUGA_HOME = homeBefore;
});

describe('schedules in a worktree shared with a friend', () => {
  it('reach them at the share and on each change, and stop when the share ends', { timeout: 60_000 }, async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    stops.push(launchSchedules({ session: ata.session, store: ata.store, demo: true, tickMs: 0 }));
    const schedules = schedulesOf(ata.session)!;
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const wsId = project.workspaces.find((w) => !w.archived && !w.external && w.kind === 'worktree')!.id;
    const channel = `ws:${wsId}`;
    const seen = () => kay.store.getState().sharedSchedules[wsId] ?? [];
    const made = schedules.create(channel, EVERY_FIVE);

    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'view' });
    await settle(() => seen().length === 1);
    expect(seen()[0]).toMatchObject({ id: made.id, title: 'Check', sentence: 'Every 5 minutes', status: 'never' });

    schedules.setEnabled(made.id, false);
    await settle(() => seen()[0]?.status === 'paused');

    ata.session.sharing.unshareFriend({ peerId: kay.id, projectId: project.id });
    await settle(() => !kay.store.getState().shared.some((w) => w.id === wsId));
    expect(seen()).toEqual([]);
    schedules.create(channel, { ...EVERY_FIVE, title: 'After' });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen()).toEqual([]);
  });
});
