import { type ChildProcess, spawn } from 'node:child_process';
import type { KeepAwake } from '../shared/settings-schema.js';

/**
 * Keeping the Mac awake for your phone (docs/companion.md, "Keeping your Mac awake", BLG-127).
 * A sleeping Mac can't be woken over the internet (Wake-on-LAN needs the same network, and a dorm
 * or café Wi-Fi drops it), so instead it doesn't fall asleep while a phone is paired and you asked:
 * `caffeinate` holds the assertion, `-s` only on power (macOS drops it on battery by itself) or
 * `-i` always, and `-w` ties it to this process, so it never outlives Beluga. The display still
 * sleeps; closing a laptop's lid still sleeps it (macOS doesn't let an app stop that).
 */

export type Spawn = (cmd: string, args: readonly string[]) => Pick<ChildProcess, 'kill' | 'once'>;

const defaultSpawn: Spawn = (cmd, args) => spawn(cmd, [...args], { stdio: 'ignore' });

export class Awake {
  private child?: Pick<ChildProcess, 'kill' | 'once'>;
  private holding?: Exclude<KeepAwake, 'off'>;

  constructor(
    private readonly opts: { readonly spawn?: Spawn; readonly platform?: NodeJS.Platform; readonly log?: (line: string) => void } = {},
  ) {}

  /** Hold (or let go of) the assertion: `mode` as set, `wanted` while a phone is paired. */
  set(mode: KeepAwake, wanted: boolean): void {
    const next = wanted && mode !== 'off' && (this.opts.platform ?? process.platform) === 'darwin' ? mode : undefined;
    if (next === this.holding) return;
    this.release();
    if (!next) return;
    const child = (this.opts.spawn ?? defaultSpawn)('caffeinate', [next === 'power' ? '-s' : '-i', '-w', String(process.pid)]);
    this.child = child;
    this.holding = next;
    child.once('error', (err: Error) => this.opts.log?.(`companion: could not keep the Mac awake: ${err.message}`));
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.holding = undefined;
    });
    this.opts.log?.(`companion: keeping the Mac awake (${next === 'power' ? 'on power' : 'always'})`);
  }

  /** What's held now. */
  get mode(): KeepAwake {
    return this.holding ?? 'off';
  }

  release(): void {
    const child = this.child;
    this.child = undefined;
    this.holding = undefined;
    child?.kill();
  }
}
