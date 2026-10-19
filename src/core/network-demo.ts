import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity } from '../net/crypto.js';
import { Mesh } from '../net/mesh/mesh.js';
import { dmConversation, groupConversation } from '../net/mesh/views.js';
import { type NetworkService, startNetwork } from './network.js';
import { demoScreenshot } from '../demo-image.js';
import { ChatClaude } from './chat/claude.js';
import { demoAnswerFromPrompt } from './chat/demo-answers.js';
import { ChatFiles } from './chat/files.js';
import type { Store } from './store.js';

const CHECKLIST = `# Friday release

- [x] Staging green
- [x] Migrations dry-run
- [ ] Smoke test checkout
- [ ] Announce in #launch
`;

/** A demo friend's Mac shares files and answers when their Claude is asked, like a real one (with made-up answers). */
function demoChat(mesh: Mesh, dir: string, pace: number): { files: ChatFiles; claude: ChatClaude } {
  const files = new ChatFiles({ mesh, dir: path.join(dir, 'chat-files') });
  const claude = new ChatClaude({
    mesh,
    files,
    answer: async (req) => {
      await new Promise((r) => setTimeout(r, (1800 + Math.random() * 1500) * pace));
      return demoAnswerFromPrompt(req.system, req.prompt);
    },
    policy: () => 'everyone',
    trustOf: () => 'trusted',
  });
  return { files, claude };
}

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
  const { demoResponder } = await import('./gateway/demo.js');
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
  const pace = Number(process.env.KLAUD_DEMO_PACE) || 1;
  const chats = { bob: demoChat(bob, path.join(base, 'bob'), pace), mia: demoChat(mia, path.join(base, 'mia'), pace) };
  const group = bob.createGroup('launch', [meId, mia.peerId]);
  bob.sendGroup(group.id, 'Morning! Staging is green, ready when you are.');
  // bob shares the checklist and a screenshot: they come straight from his Mac.
  void (async () => {
    writeFileSync(path.join(base, 'release-checklist.md'), CHECKLIST);
    writeFileSync(path.join(base, 'checkout.png'), demoScreenshot());
    const shared = await chats.bob.files.share([path.join(base, 'release-checklist.md'), path.join(base, 'checkout.png')]);
    if (!stopped) bob.sendGroup(group.id, 'Checklist for Friday, and how checkout looks on staging.', { files: shared });
  })().catch(() => undefined);
  bob.sendDm(meId, 'Could you look at the deploy script later?');
  // mia writes once the group has reached her (in the background: the demo doesn't wait).
  void until(() => mia.summary().groups.some((g) => g.id === group.id && g.active)).then((ok) => {
    if (ok && !stopped) mia.sendGroup(group.id, 'Copy for the landing page is in. Can someone review?');
  });

  // Their Claudes answer your Claude's tasks (core/gateway/demo.ts). You trust bob; mia asks you each time.
  const responders = { bob: demoResponder(bob, 'bob', meId, base), mia: demoResponder(mia, 'mia', meId, base) };
  store.dispatch({ type: 'remembered', people: { ...store.getState().remembered, [bob.peerId]: { name: 'bob', trust: 'trusted' } } });

  // They answer you (mention Claude and their Claude asks yours something).
  bob.on('message', (m) => {
    if (m.mine) return;
    if (m.conversation === dmConversation(meId)) setTimeout(() => !stopped && bob.sendDm(meId, `On it: “${m.text.slice(0, 60)}”`), 1200).unref();
    if (m.conversation === dmConversation(meId) && /claude|screenshot/i.test(m.text)) setTimeout(() => !stopped && responders.bob.askBack(/screenshot/i.test(m.text) ? 'screenshot' : 'question'), 2000).unref();
  });
  mia.on('message', (m) => {
    if (!m.mine && m.conversation === dmConversation(meId) && /claude|screenshot/i.test(m.text)) setTimeout(() => !stopped && responders.mia.askBack(/screenshot/i.test(m.text) ? 'screenshot' : 'question'), 1500).unref();
  });
  mia.on('message', (m) => {
    if (m.mine || m.from !== meId || m.conversation !== groupConversation(group.id)) return;
    setTimeout(() => !stopped && mia.sendGroup(group.id, 'Sounds good 👍'), 1500).unref();
  });

  return {
    mesh: me.mesh,
    stop: async () => {
      stopped = true;
      for (const c of Object.values(chats)) {
        c.claude.stop();
        c.files.stop();
      }
      responders.bob.stop();
      responders.mia.stop();
      await me.stop();
      await Promise.all([bob.close(), mia.close()]);
      await testnet.destroy();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
