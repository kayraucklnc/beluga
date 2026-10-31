import { type ChildProcess, spawn } from 'node:child_process';
import type { KeepAwake } from '../shared/settings-schema.js';

/**
 * Keeping the Mac awake for your phone (docs/companion.md, "Keeping your Mac awake", BLG-127).
 * A sleeping Mac can't be woken over the internet (Wake-on-LAN needs the same network, and a dorm
 * or café Wi-Fi drops it), so instead it doesn't fall asleep while a phone is paired and you asked:
 * `caffeinate` holds the assertion, `-s` only on power (macOS drops it on battery by itself) or
 * `-i` always, and `-w` ties it to this process, so it never outlives Beluga. The display still
 * sleeps; closing a laptop's lid still sleeps it (macOS doesn't let an app stop that).
 *
 * Linux: `systemd-inhibit` blocks sleep for as long as its command runs, and the command is a
 * `tail --pid` that ends with this process. Windows: PowerShell asks SetThreadExecutionState for
 * the system to stay up, then waits for this process to end. Neither can tell power from battery
 * by itself, so "on power" holds it there too.
 */

export type Spawn = (cmd: string, args: readonly string[]) => Pick<ChildProcess, 'kill' | 'once'>;

/** How each system is kept awake: the command that holds it until it's stopped or this process ends. */
const HOLD: Partial<Record<NodeJS.Platform, (mode: Exclude<KeepAwake, 'off'>, pid: number) => readonly [string, readonly string[]]>> = {
  darwin: (mode, pid) => ['caffeinate', [mode === 'power' ? '-s' : '-i', '-w', String(pid)]],
  linux: (_mode, pid) => ['systemd-inhibit', ['--what=sleep:idle', '--who=Beluga', '--why=Your phone is paired', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null']],
  win32: (_mode, pid) => [
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Name P -Namespace Beluga -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void][Beluga.P]::SetThreadExecutionState(0x80000001); Wait-Process -Id ${pid}`],
  ],
};

const defaultSpawn: Spawn = (cmd, args) => spawn(cmd, [...args], { stdio: 'ignore' });

export class Awake {
  private child?: Pick<ChildProcess, 'kill' | 'once'>;
  private holding?: Exclude<KeepAwake, 'off'>;

  constructor(
    private readonly opts: { readonly spawn?: Spawn; readonly platform?: NodeJS.Platform; readonly log?: (line: string) => void } = {},
  ) {}

  /** Hold (or let go of) the assertion: `mode` as set, `wanted` while a phone is paired. */
  set(mode: KeepAwake, wanted: boolean): void {
    const platform = this.opts.platform ?? process.platform;
    const how = HOLD[platform];
    const next = wanted && mode !== 'off' && how ? mode : undefined;
    if (next === this.holding) return;
    this.release();
    if (!next || !how) return;
    const [cmd, args] = how(next, process.pid);
    const child = (this.opts.spawn ?? defaultSpawn)(cmd, args);
    this.child = child;
    this.holding = next;
    child.once('error', (err: Error) => this.opts.log?.(`companion: could not keep this computer awake: ${err.message}`));
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.holding = undefined;
    });
    this.opts.log?.(`companion: keeping this computer awake (${next === 'power' ? 'on power' : 'always'})`);
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
