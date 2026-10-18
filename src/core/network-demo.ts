import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity } from '../net/crypto.js';
import { Mesh } from '../net/mesh/mesh.js';
import { dmConversation, groupConversation } from '../net/mesh/views.js';
import { type NetworkService, startNetwork } from './network.js';
import type { Store } from './store.js';

/** Wait (up to 20 s) for something to become true. */
async function until(ok: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * The demo's klaud network: you, bob and mia as real mesh nodes on a private DHT inside this
 * process (nothing touches the internet or your ~/.klaud). bob and mia are your friends, the
 * three of you share a group, and they answer when you write to them.
 */
export async function startDemoNetwork(store: Store, name: string): Promise<NetworkService> {
  const createTestnet = (await import('hyperdht/testnet.js')).default;
  const testnet = await createTestnet(3, { host: '127.0.0.1' });
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaud-demo-network-'));
  const where = { bootstrap: testnet.bootstrap, host: '127.0.0.1' };
  const friend = (n: string): Promise<Mesh> => Mesh.start({ identity: generateIdentity(), name: n, dir: path.join(base, n), ...where });
  const [bob, mia] = await Promise.all([friend('bob'), friend('mia')]);
  const me = await startNetwork({ store, identity: generateIdentity(), name, dir: path.join(base, 'me'), ...where });
  const meId = me.mesh.peerId;
  await me.mesh.accept((await bob.createInvite()).link);
  await me.mesh.accept((await mia.createInvite()).link);
  await mia.accept((await bob.createInvite()).code);
  mia.setPresence({ state: 'away', note: 'in a meeting' });
  let stopped = false;
  const group = bob.createGroup('launch', [meId, mia.peerId]);
  bob.sendGroup(group.id, 'Morning! Staging is green, ready when you are.');
  bob.sendDm(meId, 'Could you look at the deploy script later?');
  // mia writes once the group has reached her (in the background: the demo doesn't wait).
  void until(() => mia.summary().groups.some((g) => g.id === group.id && g.active)).then((ok) => {
    if (ok && !stopped) mia.sendGroup(group.id, 'Copy for the landing page is in. Can someone review?');
  });

  // They answer you.
  bob.on('message', (m) => {
    if (m.mine) return;
    if (m.conversation === dmConversation(meId)) setTimeout(() => !stopped && bob.sendDm(meId, `On it: “${m.text.slice(0, 60)}”`), 1200).unref();
  });
  mia.on('message', (m) => {
    if (m.mine || m.from !== meId || m.conversation !== groupConversation(group.id)) return;
    setTimeout(() => !stopped && mia.sendGroup(group.id, 'Sounds good 👍'), 1500).unref();
  });

  return {
    mesh: me.mesh,
    stop: async () => {
      stopped = true;
      await me.stop();
      await Promise.all([bob.close(), mia.close()]);
      await testnet.destroy();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
