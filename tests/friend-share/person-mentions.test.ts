import { afterEach, describe, expect, it } from 'vitest';
import { type NetworkService, attachNetwork } from '../../src/core/network.js';
import { createDemoWorkspaces } from '../../src/demo.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** "@ata" in what you say to your Claude tells Ata; "@claude:ata" stays for your Claude to ask Ata's Claude. */

let net: Crowd | undefined;
const macs: Mac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

describe('mentioning a friend in a conversation with your Claude', () => {
  it('tells the person, and keeps "@claude:ata" in the words your Claude gets', async () => {
    net = await crowd();
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    const ata = await mac(net, 'ata');
    macs.push(kay, ata);
    await befriend(kay.person, ata.person);
    attachNetwork(kay.session, { mesh: kay.person.mesh } as unknown as NetworkService);
    await settle(() => kay.store.getState().network.friends.some((f) => f.peerId === ata.id));
    const project = kay.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => !w.archived && !w.external && w.kind === 'worktree')!;
    const channel = `ws:${ws.id}`;

    // Ata's Claude, said outright: your Claude gets the words as written, and nobody is "mentioned".
    expect(kay.session.submit('@claude:ata check the server logs', { channel })).toBe(true);
    await settle(() => kay.runs.some((r) => r.prompt.includes('@claude:ata check the server logs')));
    expect(ata.person.mesh.dmHistory(kay.id)).toHaveLength(0);

    // Ata, the person: Ata gets a direct message saying where.
    expect(kay.session.submit('@ata can you look at the retry change?', { channel })).toBe(true);
    await settle(() => ata.person.mesh.dmHistory(kay.id).some((m) => m.text.includes('kay mentioned you in')));
    const note = ata.person.mesh.dmHistory(kay.id).find((m) => m.text.includes('kay mentioned you in'))!;
    expect(note.text).toContain(`${ws.name} (bob-api)`);
    expect(note.text).toContain('@ata can you look at the retry change?');
    expect(kay.store.getState().log.some((l) => l.type === 'system' && l.channel === channel && l.text.startsWith('Told ata you mentioned them'))).toBe(true);
  }, 60_000);
});
