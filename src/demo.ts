import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockBackend } from './agent/mock.js';
import { Session } from './core/session.js';
import { ShareService } from './core/shares.js';
import { Store, initialState } from './core/store.js';
import { type RoomKeys } from './net/crypto.js';
import { PeerClient } from './net/peer-client.js';
import { WorkspaceManager } from './workspaces/manager.js';
import { WorkspaceStore } from './workspaces/store.js';

const SUNSET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d2440"/><stop offset="0.55" stop-color="#c8667a"/><stop offset="1" stop-color="#f3b07a"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b3f63"/><stop offset="1" stop-color="#14172a"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" fill="url(#sky)"/>
  <circle cx="200" cy="112" r="30" fill="#ffd9a0"/>
  <path d="M0 120 L60 70 L105 105 L150 60 L210 118 L250 88 L320 125 L320 180 L0 180 Z" fill="#2b2d4a"/>
  <rect y="128" width="320" height="52" fill="url(#sea)"/>
  <rect x="170" y="134" width="60" height="3" fill="#ffd9a0" opacity="0.7"/>
  <rect x="182" y="144" width="36" height="2" fill="#ffd9a0" opacity="0.5"/>
  <rect x="190" y="154" width="20" height="2" fill="#ffd9a0" opacity="0.35"/>
</svg>
`;

const BOB_FILES: Record<string, string> = {
  'README.md':
    '# Bob API\n\nA tiny service that powers **bob\'s** side project. See [the docs](https://example.com).\n\n## Getting started\n\n1. `npm install`\n2. `npm run dev`\n3. Open http://localhost:3000\n\n## Status\n\n- Auth: *not started*\n- Payments: in progress\n- Deploy: done\n\n> Tip: ask kay\'s Claude to review the auth plan.\n',
  'NOTES.md': '# Notes\n\n- TODO: add auth\n- Stripe webhooks are flaky on retries\n',
  'src/server.ts': "import express from 'express';\n\nconst app = express();\n// TODO: add auth\napp.get('/api/health', (_req, res) => res.send('ok'));\n\napp.listen(3000);\n",
  'design/sunset.svg': SUNSET_SVG,
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

// ---------------------------------------------------------------------------
// Demo projects: real git repos with worktrees, so every workspace feature works.
// ---------------------------------------------------------------------------


const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=demo@klaude.dev', '-c', 'user.name=klaude demo', ...args], { cwd, stdio: 'ignore' });
};

function demoRepo(base: string, name: string, files: Record<string, string>): string {
  const origin = path.join(base, 'remotes', `${name}.git`);
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  const dir = path.join(base, 'Projects', name);
  writeTree(dir, files);
  gitIn(dir, 'init', '-b', 'main');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-m', 'Initial commit');
  gitIn(dir, 'remote', 'add', 'origin', origin);
  gitIn(dir, 'push', '-u', 'origin', 'main');
  gitIn(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

/** Two sample projects with worktrees in different states, plus saved conversations. */
export async function createDemoWorkspaces(): Promise<WorkspaceManager> {
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaude-demo-projects-'));
  demoRepo(base, 'bob-api', BOB_FILES);
  demoRepo(base, 'landing', YOUR_FILES);
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'Projects')], projects: [], hidden: [] });
  const mgr = new WorkspaceManager(store);
  await mgr.refresh();
  const api = mgr.list.find((p) => p.name === 'bob-api');
  const landing = mgr.list.find((p) => p.name === 'landing');
  if (api) {
    const auth = await mgr.createWorktree(api.id, 'add-auth');
    writeTree(auth.path, { 'src/auth.ts': "export function requireUser(req: { session?: string }) {\n  if (!req.session) throw new Error('unauthorized');\n}\n" });
    gitIn(auth.path, 'add', '.');
    gitIn(auth.path, 'commit', '-m', 'Add requireUser middleware');
    writeTree(auth.path, { 'src/server.ts': "import express from 'express';\nimport { requireUser } from './auth';\n\nconst app = express();\napp.use('/api/payments', requireUser);\napp.get('/api/health', (_req, res) => res.send('ok'));\n\napp.listen(3000);\n" });
    gitIn(auth.path, 'add', '.');
    gitIn(auth.path, 'commit', '-m', 'Protect payments routes');
    const tests = await mgr.createWorktree(api.id, 'webhook-retries');
    writeTree(tests.path, { 'src/webhooks.ts': '// retry with backoff\nexport const MAX_RETRIES = 5;\n' });
    await mgr.createChat(api.id, 'How do deploys work?');
  }
  if (landing) {
    const hero = await mgr.createWorktree(landing.id, 'new-hero');
    writeTree(hero.path, { 'content/hero.md': '# Build together\n\nYou, your friends, and everyone\'s Claude.\n' });
  }
  await mgr.refresh();
  return mgr;
}
