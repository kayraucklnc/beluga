import type DHT from 'hyperdht';
import type { KeyPair } from 'hyperdht';
import { openTunnel, waitUntilReachable } from '../net/tunnel.js';
import type { RelayRecord } from './protocol.js';
import { RelayServer } from './relay.js';

/**
 * How phones find this Mac when a direct connection can't be made (docs/companion.md, "Any
 * network"): the relay server (relay.ts) behind a Cloudflare quick tunnel, and the Mac's signed
 * record on the DHT naming the tunnel's current URL (it changes whenever cloudflared restarts).
 * Runs only while the companion host does (a phone paired, or a pairing open).
 */

/** Makes the relay public: cloudflared's quick tunnel, none, or (tests) a function. */
export type RelayTunnel = 'cloudflared' | 'off' | ((localPort: number) => Promise<{ url: string; close(): void }>);

/** How often the DHT record is put again (records fade from the DHT after a while). */
const REPUBLISH_MS = 10 * 60_000;
/** A tunnel that died is opened again after this long. */
const RETRY_MS = 30_000;

export interface ReachOptions {
  readonly tunnel: RelayTunnel;
  /** The relay's URL changed (it's in pairing links and welcomes). */
  readonly onChange: () => void;
  readonly log?: (line: string) => void;
}

export class Reach {
  readonly server: RelayServer;
  private url?: string;
  private tunnel?: { close(): void };
  private running = false;
  private retry?: NodeJS.Timeout;
  private republish?: NodeJS.Timeout;
  private publishing?: { node: DHT; keyPairs: () => readonly KeyPair[] };

  constructor(private readonly opts: ReachOptions) {
    this.server = new RelayServer(opts.log);
  }

  /** The relay's base URL (`wss://….trycloudflare.com/companion`), once its tunnel answers. */
  relayUrl(): string | undefined {
    return this.url;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.server.listen();
    void this.openTunnel();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.retry);
    clearInterval(this.republish);
    this.publishing = undefined;
    this.tunnel?.close();
    this.tunnel = undefined;
    const had = this.url;
    this.url = undefined;
    await this.server.close();
    if (had) this.opts.onChange();
  }

  /** Keep the record of where this Mac's relay is on the DHT, under each of these key pairs. */
  publishOn(node: DHT, keyPairs: () => readonly KeyPair[]): void {
    this.publishing = { node, keyPairs };
    clearInterval(this.republish);
    this.republish = setInterval(() => void this.publish(), REPUBLISH_MS);
    this.republish.unref();
    void this.publish();
  }

  /** Put the record now (the relay changed, a pairing opened). */
  async publish(): Promise<void> {
    const p = this.publishing;
    if (!p || !this.running) return;
    const record: RelayRecord = { v: 1, at: Date.now(), ...(this.url ? { relay: this.url } : {}) };
    const value = Buffer.from(JSON.stringify(record));
    // Each put must outnumber the last one stored: seconds since the epoch, always rising.
    const seq = Math.floor(Date.now() / 1000);
    await Promise.all(p.keyPairs().map((kp) => p.node.mutablePut(kp, value, { seq }).catch((err: unknown) => this.opts.log?.(`companion: relay record not stored: ${String(err)}`))));
  }

  private async openTunnel(): Promise<void> {
    const kind = this.opts.tunnel;
    if (kind === 'off' || !this.running) return;
    try {
      let url: string;
      if (typeof kind === 'function') {
        const t = await kind(this.server.localPort);
        this.tunnel = t;
        url = t.url;
      } else {
        const t = await openTunnel('cloudflared', this.server.localPort, {
          onDied: (reason) => {
            this.opts.log?.(`companion: relay tunnel stopped: ${reason}`);
            this.lost();
          },
        });
        if (!t) return;
        this.tunnel = t;
        // A fresh quick-tunnel name takes a moment to resolve: hand it out once it answers.
        if (!(await waitUntilReachable(t.publicUrl, 90_000))) throw new Error('the tunnel never answered');
        url = `${t.publicUrl.replace(/^http/, 'ws')}/companion`;
      }
      if (!this.running) return this.tunnel?.close();
      this.url = url;
      this.opts.onChange();
      void this.publish();
    } catch (err) {
      this.opts.log?.(`companion: no relay: ${err instanceof Error ? err.message : String(err)}`);
      this.lost();
    }
  }

  private lost(): void {
    this.tunnel?.close();
    this.tunnel = undefined;
    if (this.url) {
      this.url = undefined;
      this.opts.onChange();
      void this.publish();
    }
    if (!this.running) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.openTunnel(), RETRY_MS);
    this.retry.unref();
  }
}
