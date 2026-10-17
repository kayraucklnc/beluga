import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockBackend } from './agent/mock.js';
import { Session } from './core/session.js';
import { ShareService } from './core/shares.js';
import { Store, initialState } from './core/store.js';
import { type RoomKeys } from './net/crypto.js';
import { PeerClient } from './net/peer-client.js';

const BOB_FILES: Record<string, string> = {
  'README.md':
    '# Bob API\n\nA tiny service that powers **bob\'s** side project. See [the docs](https://example.com).\n\n## Getting started\n\n1. `npm install`\n2. `npm run dev`\n3. Open http://localhost:3000\n\n## Status\n\n- Auth: *not started*\n- Payments: in progress\n- Deploy: done\n\n> Tip: ask kay\'s Claude to review the auth plan.\n',
  'NOTES.md': '# Notes\n\n- TODO: add auth\n- Stripe webhooks are flaky on retries\n',
  'src/server.ts': "import express from 'express';\n\nconst app = express();\n// TODO: add auth\napp.get('/api/health', (_req, res) => res.send('ok'));\n\napp.listen(3000);\n",
  'package.json': '{\n  "name": "bob-api",\n  "scripts": { "dev": "tsx src/server.ts", "test": "vitest" }\n}\n',
};

const YOUR_FILES: Record<string, string> = {
  'README.md': '# Landing page\n\nMarketing site for the launch. Built with Astro.\n\n- `npm run dev` to preview\n- Copy lives in `content/`\n',
  'content/hero.md': '# Ship together\n\nYour friends. Their Claude. One terminal.\n',
};

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

/** Sample folders for the demo: yours and a pretend friend's. */
export function createDemoFolders(): { mine: string; bob: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaude-demo-'));
  const mine = path.join(base, 'landing');
  const bob = path.join(base, 'api');
  writeTree(mine, YOUR_FILES);
  writeTree(bob, BOB_FILES);
  return { mine, bob };
}

const BOB_LINES = ['hey! just pushed my API notes', 'can your Claude take a look at the auth plan?', 'nice, thanks!'];

/**
 * A pretend friend who joins the room, shares a folder, lets you use a (simulated)
 * Claude, and chats back. Lets you try every feature alone.
 */
export function startDemoFriend(url: string, keys: RoomKeys, folder: string): Session {
  const shares = new ShareService([{ name: 'api', root: folder, writable: false }]);
  const store = new Store(initialState('demo', 'auto'));
  const client = new PeerClient({ url, keys, profile: { name: 'bob', shares: shares.infos, agent: true } });
  const bob = new Session({ client, store, shares, agentCwd: folder, createAgent: (bridge) => createMockBackend(bridge) });
  let said = 0;
  const say = (delay: number): void => {
    const line = BOB_LINES[said++];
    if (line) setTimeout(() => bob.sendChat(line, false), delay);
  };
  client.once('welcome', () => {
    bob.updateUsage({ plan: 'pro', fiveHour: { pct: 64 }, week: { pct: 41 } });
    say(1200);
  });
  client.on('message', (msg) => {
    if (msg.from !== client.peerId && msg.body.kind === 'chat' && !msg.body.byAgent && said < BOB_LINES.length) say(1500);
  });
  bob.start();
  return bob;
}
