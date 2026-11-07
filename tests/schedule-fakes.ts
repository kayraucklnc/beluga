import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { launchSchedules } from '../src/core/schedule/launch.js';
import { schedulesOf } from '../src/core/schedule/registry.js';
import type { Schedules } from '../src/core/schedule/service.js';
import { saveSettings, type Settings } from '../src/core/settings.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { TerminalManager } from '../src/terminal/index.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { attach, waitFor } from './helpers.js';

/**
 * A test daemon for schedules: a real session and its lanes over a real git project, with a fake
 * agent backend and a clock the test moves. The tick is called by hand.
 */

const keys = deriveKeys(generateSecret());
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

export interface Harness {
  readonly session: Session;
  readonly store: Store;
  readonly manager: WorkspaceManager;
  readonly runs: AgentRunInput[];
  /** A new chat of the project, with its channel. */
  chat(title?: string): Promise<string>;
  /** Start (or restart) the service; `on` writes the setting first. */
  launch(on?: boolean): Schedules;
  /** Stop the service as a daemon stop does. */
  stopService(): void;
  clock: { now: number };
  /** A second person's daemon in the same room, with its own schedules. It uses the same settings. */
  person(name: string): Promise<Person>;
  /** The system lines of a channel. */
  lines(channel: string): string[];
  /** What the fake agent does on each run: a promise it holds, or an answer. */
  script: { run: (input: AgentRunInput) => Promise<string> };
  close(): Promise<void>;
}

export interface Person {
  readonly session: Session;
  readonly store: Store;
  readonly client: PeerClient;
}

export async function harness(): Promise<Harness> {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-schedules-')));
  const homeBefore = process.env.BELUGA_HOME;
  process.env.BELUGA_HOME = path.join(base, 'beluga-home');
  mkdirSync(process.env.BELUGA_HOME, { recursive: true });
  const hub: Hub = await startHub({ keys });
  const terminals = new TerminalManager();

  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');

  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
  const manager = new WorkspaceManager(wsStore);
  await manager.refresh();

  const runs: AgentRunInput[] = [];
  const script: Harness['script'] = { run: async () => 'done' };
  const session = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces: manager,
    terminals,
    hasGh: async () => false,
    findPr: async () => undefined,
    open: () => undefined,
    desktopNotify: () => undefined,
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    saveSettings: (patch: Partial<Settings>) => void saveSettings(patch),
    createAgent: (): AgentBackend => ({
      nameTask: async () => 'task',
      run: async (input) => {
        runs.push(input);
        input.place?.onSession(input.place.resume ?? `session-${runs.length}`);
        return script.run(input);
      },
    }),
  });
  const screen = attach(session);
  session.start();
  await waitFor(() => store.getState().self, 4000);

  const clock = { now: Date.UTC(2026, 10, 7, 12, 0) };
  let stop: (() => void) | undefined;
  const people: Array<() => Promise<void>> = [];
  return {
    session,
    store,
    manager,
    runs,
    clock,
    script,
    chat: async (title = 'A chat') => {
      const project = manager.list.find((p) => p.root)!;
      const ws = await session.workspaces!.newChat(project.id, title, undefined, { quiet: true });
      return `ws:${ws!.id}`;
    },
    launch: (on = true) => {
      saveSettings({ chatSchedules: on });
      stop?.();
      stop = launchSchedules({ session, store, demo: false, now: () => clock.now, tickMs: 0 });
      return schedulesOf(session)!;
    },
    stopService: () => {
      stop?.();
      stop = undefined;
    },
    person: async (name) => {
      const theirStore = new Store(initialState('test', 'ask'));
      const theirClient = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: [], agent: true }, reconnect: false });
      const theirs = new Session({ client: theirClient, store: theirStore, shares: new ShareService([]), agentCwd: base, createAgent: (): AgentBackend => ({ nameTask: async () => 'task', run: async () => 'done' }) });
      const theirScreen = attach(theirs);
      theirs.start();
      await waitFor(() => theirStore.getState().self, 4000);
      const off = launchSchedules({ session: theirs, store: theirStore, demo: true, now: () => clock.now, tickMs: 0 });
      people.push(async () => {
        off();
        theirScreen.close?.();
        await theirs.stop();
      });
      return { session: theirs, store: theirStore, client: theirClient };
    },
    lines: (channel) => store.getState().log.flatMap((l) => (l.channel === channel && l.type === 'system' ? [l.text] : [])),
    close: async () => {
      for (const leave of people) await leave();
      stop?.();
      screen.close?.();
      await session.stop();
      terminals.closeAll();
      await hub.close();
      process.env.BELUGA_HOME = homeBefore;
    },
  };
}
