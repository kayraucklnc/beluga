import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeOf } from '../core/claude-code/launch.js';
import { belugaHome } from '../core/home.js';
import type { Session } from '../core/session.js';
import type { Store } from '../core/store.js';
import { installedVersion } from '../core/version.js';
import { dispatchCall } from '../daemon/dispatch.js';
import type { Identity } from '../net/crypto.js';
import { listScratch } from '../workspaces/scratch.js';
import { assistantOf } from '../core/assistant/registry.js';
import { ASSISTANT_CHANNEL } from '../shared/assistant.js';
import { DeviceBook } from './devices.js';
import { CompanionHost } from './host.js';
import { macIdleMs } from './push.js';
import { attachCompanion, detachCompanion } from './registry.js';
import type { ConvOutput } from './views.js';

/**
 * Start the phone companion for the daemon (the Mac app's Beluga): the device book in
 * ~/.beluga/devices.json and the CompanionHost (which runs a DHT node only while a phone is
 * paired or a pairing is open). The demo keeps its phones in a temporary folder.
 *
 * Outputs for the phone's views come from disk, so they're gathered here in the background (a
 * conversation's scratch folder, and what its sub-agents made, as the Mac's Outputs tab shows
 * them) for the conversations a phone has open plus the latest few, every few seconds while a
 * phone is linked; views read the cache, never the disk.
 */

const REFRESH_MS = 5_000;
/** Besides the ones on a phone's screen: the latest conversations, for Home's outputs strip. */
const RECENT = 8;

class OutputCache {
  private readonly cache = new Map<string, readonly ConvOutput[]>();
  private watched: readonly string[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly session: Session,
    private readonly store: Store,
    private readonly changed: () => void,
  ) {}

  get = (channel: string): readonly ConvOutput[] => this.cache.get(channel) ?? [];

  watch(channels: readonly string[], linked: boolean): void {
    this.watched = channels;
    if (linked && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
      this.timer.unref();
      void this.refresh();
    } else if (!linked && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (linked) void this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private channels(): string[] {
    const state = this.store.getState();
    const last = new Map<string, number>();
    for (const l of state.log) if (l.channel.startsWith('ws:')) last.set(l.channel, Math.max(last.get(l.channel) ?? 0, l.ts));
    const recent = [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, RECENT).map(([c]) => c);
    // Your Mac always: Home's "Ask your Mac" counts what it sent you.
    return [...new Set([ASSISTANT_CHANNEL, ...this.watched, ...recent])];
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = this.store.getState();
      let moved = false;
      for (const channel of this.channels()) {
        if (channel === ASSISTANT_CHANNEL) {
          // Its scratch folder: the screenshots and files it sent you (core/assistant).
          const mine = (await assistantOf(this.session)?.outputs().catch(() => [])) ?? [];
          const all = mine.slice(0, 100);
          if (JSON.stringify(this.cache.get(channel)) !== JSON.stringify(all)) moved = true;
          this.cache.set(channel, all);
          continue;
        }
        const wsId = channel.slice(3);
        const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId);
        if (!ws?.path) continue;
        const scratch = (await listScratch(ws.path).catch(() => [])).map((f) => ({ path: path.join(ws.path, f.path), size: f.size, ts: f.mtime, cwd: ws.path }));
        const agents = this.agentOutputs(wsId, ws.path);
        const all = [...agents, ...scratch].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 100);
        const before = this.cache.get(channel);
        if (JSON.stringify(before) !== JSON.stringify(all)) moved = true;
        this.cache.set(channel, all);
      }
      if (moved) this.changed();
    } finally {
      this.busy = false;
    }
  }

  /** What the sub-agents of this workspace's own Claude Code sessions made (claudeCode.outputs). */
  private agentOutputs(wsId: string, cwd: string): ConvOutput[] {
    let watcher: ReturnType<typeof claudeCodeOf>;
    try {
      watcher = claudeCodeOf(this.session);
    } catch {
      return [];
    }
    return this.store
      .getState()
      .claudeCode.sessions.filter((s) => s.workspaceId === wsId)
      .flatMap((s) =>
        s.agents.flatMap((a) =>
          watcher.outputs(s.id, a.id).outputs.map((o) => ({ path: o.path, size: o.size, ts: o.mtime, by: a.toolUseId ?? a.id, cwd })),
        ),
      );
  }
}

export interface CompanionLaunch {
  readonly session: Session;
  readonly store: Store;
  readonly identity: Identity;
  readonly demo: boolean;
  readonly log?: (line: string) => void;
}

/** The Mac's name as people know it ("Kayra’s MacBook Pro"): its Sharing name, else its host name. */
let named: string | undefined;
function macName(): string {
  if (named) return named;
  try {
    if (process.platform === 'darwin') named = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim() || undefined;
  } catch {
    // no scutil: the host name will do
  }
  named ??= os.hostname().replace(/\.local$/, '').replace(/-/g, ' ') || 'Your Mac';
  return named;
}

export function launchCompanion(opts: CompanionLaunch): () => Promise<void> {
  const dir = opts.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-companion-')) : belugaHome();
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  let host: CompanionHost | undefined;
  const outputs = new OutputCache(opts.session, opts.store, () => host?.refreshViews());
  host = new CompanionHost({
    identity: opts.identity,
    store: opts.store,
    devices,
    call: (clientId, method, args) => dispatchCall(opts.session, clientId, method, args),
    macName,
    version: installedVersion(),
    thumbsDir: path.join(dir, 'companion', 'thumbs'),
    outputs: outputs.get,
    watching: (channels, linked) => outputs.watch(channels, linked),
    idleMs: macIdleMs,
    // The relay through Cloudflare, unless Remote access is set to direct only (or the network only),
    // or it's the demo (nothing leaves the computer).
    relay: opts.demo || ['p2p', 'none'].includes(opts.store.getState().prefs.tunnel) ? 'off' : 'cloudflared',
    ...(opts.log ? { log: opts.log } : {}),
  });
  attachCompanion(opts.session, host);
  void host.start().catch((err: unknown) => opts.log?.(`companion: could not start: ${String(err)}`));
  return async () => {
    outputs.stop();
    detachCompanion(opts.session);
    await host?.stop();
    host = undefined;
  };
}
