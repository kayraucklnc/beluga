import net from 'node:net';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { SystemPort } from '../core/gateway/device.js';
import type { PhoneTools } from '../agent/types.js';
import { phoneBrief } from '../agent/phone-tools.js';
import { Adb, adbCandidates, findAdb, parseDevices } from './phone-adb.js';
import type { DeviceBook } from './devices.js';
import {
  type AdbView,
  type PhoneControl as PhoneControlState,
  type PhoneControlView,
  type PhoneOp,
  type PhoneRoute,
  type PhoneUse,
  type ScreenView,
  TUN_WINDOW,
} from './protocol.js';

/**
 * Your Mac using your phone (BLG-150, docs/companion.md "Your phone, from your Mac"). This is the
 * brain: it knows, per paired phone, how it can be reached right now — USB, Wireless debugging on
 * the same Wi-Fi, Wireless debugging carried through the Beluga link, or the app's Accessibility
 * service — and runs each action by the best route it has. The agent's tools (agent/phone-tools.ts)
 * call these methods; nothing here talks to Claude.
 *
 * It never acts on a phone that hasn't said `allowed` (its own Settings switch), and never on
 * anything but the owner's own paired phone.
 */

/** A phone's link, as this controller uses it (the host's PhoneLink implements it). */
export interface PhoneLinkHandle {
  readonly deviceId: string;
  /** What the phone last said it allows and how it can be reached (its `control` frame). */
  readonly control?: PhoneControlState;
  /** The six-digit Wireless-debugging pairing code the phone last sent (and when), for `adb pair`. */
  readonly adbCode?: { readonly code: string; readonly at: number };
  /** Ask the phone to do something through its Accessibility service (`req` → `reply`). */
  request(op: PhoneOp, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Open a byte tunnel to the phone's debugging port (or pairing port) and pump bytes both ways. */
  openTunnel(to: 'adb' | 'adb-pair', side: TunnelSide): TunnelEnd;
}

/** The Mac's end of a tunnel: what the socket wants done, with the phone. */
export interface TunnelSide {
  onData(bytes: Buffer): void;
  onClose(error?: string): void;
  /** The phone took `n` bytes: the Mac may send that much more (flow control). */
  onAck(n: number): void;
  onOpen(): void;
}
export interface TunnelEnd {
  send(bytes: Buffer): void;
  ack(n: number): void;
  close(error?: string): void;
}

export interface PhoneControlDeps {
  readonly sys: SystemPort;
  readonly devices: DeviceBook;
  /** The open link for a device, if any (host wires this to its PhoneLinks). */
  readonly link: (deviceId: string) => PhoneLinkHandle | undefined;
  /** View/state changed: re-publish the companion slice. */
  readonly onChange: () => void;
  readonly log?: (line: string) => void;
  /** Tests: adb's path straight away (skip discovery), and a fake home for candidates. */
  readonly adbPath?: string;
  readonly home?: string;
}

/** What a tool needs to act: which phone, by which route, and the adb for it when there is one. */
interface Reach {
  readonly route: PhoneRoute;
  readonly adb?: Adb;
  readonly link?: PhoneLinkHandle;
}

const OP_NEEDS_ADB: ReadonlySet<string> = new Set(['shell', 'logcat']);

/** How a `use` level answers a kind of action: looking is always fine; the rest follow the level. */
export function allowsWithoutAsking(use: PhoneUse, kind: 'look' | 'act' | 'shell'): boolean {
  if (kind === 'look') return use !== 'off';
  if (kind === 'act') return use === 'use' || use === 'full';
  return use === 'full';
}

export class PhoneControl {
  private adb?: { path: string; version: string };
  private adbSearched = false;
  private fetching = false;
  private adbError?: string;
  /** adb serials we connected (deviceId → serial), so we reconnect and reuse. */
  private serials = new Map<string, string>();
  /** Local tunnel listeners per device (deviceId → { server, port }) for adb over the link. */
  private tunnels = new Map<string, { server: net.Server; port: number }>();

  constructor(private readonly deps: PhoneControlDeps) {}

  private logLine(line: string): void {
    this.deps.log?.(`phone-control: ${line}`);
  }

  /** How this Mac's adb stands, for Settings › Phone. */
  adbView(): AdbView {
    if (this.adb) return { path: this.adb.path, version: this.adb.version };
    if (this.fetching) return { fetching: true };
    if (this.adbError) return { error: this.adbError };
    return {};
  }

  /** Find adb once (lazily). Call before anything that may need it. */
  async ensureAdb(): Promise<{ path: string; version: string } | undefined> {
    if (this.adb) return this.adb;
    if (this.deps.adbPath) return (this.adb = { path: this.deps.adbPath, version: 'test' });
    if (this.adbSearched) return undefined;
    this.adbSearched = true;
    this.adb = await findAdb(this.deps.sys, this.deps.home);
    if (!this.adb) this.adbError = 'adb (Android platform-tools) isn’t installed on this Mac yet.';
    this.deps.onChange();
    return this.adb;
  }

  private howUsed(deviceId: string): PhoneUse {
    return this.deps.devices.get(deviceId)?.use ?? 'off';
  }

  /** How freely Claude may use the phone it would act on now (for the owner-approval gate). */
  useLevel(): PhoneUse {
    const id = this.targetDevice();
    return id ? this.howUsed(id) : 'off';
  }

  /** Set how freely Claude may use a phone (Settings › Phone). */
  setUse(deviceId: string, use: PhoneUse): void {
    this.deps.devices.update(deviceId, { use });
    this.deps.onChange();
  }

  /** adb's current list of attached serials. */
  private async attached(): Promise<Array<{ serial: string; state: string; usb: boolean }>> {
    const adb = await this.ensureAdb();
    if (!adb) return [];
    const res = await this.deps.sys.exec(adb.path, ['devices', '-l'], 8_000).catch(() => undefined);
    return res && res.code === 0 ? parseDevices(res.stdout) : [];
  }

  /**
   * Make sure the Mac's adb is connected to this phone over Wi-Fi (same network) or through the
   * link, and return its serial — or undefined if debugging isn't reachable.
   */
  private async adbSerial(deviceId: string, state: PhoneControlState | undefined): Promise<string | undefined> {
    const adb = await this.ensureAdb();
    if (!adb || !state?.adb.on) return undefined;
    const attached = await this.attached();
    const known = this.serials.get(deviceId);
    if (known && attached.some((d) => d.serial === known && d.state === 'device')) return known;
    // Over the same Wi-Fi: connect straight to the phone's address and port.
    if (state.wifi?.ip && state.adb.port) {
      const serial = await this.connect(adb.path, `${state.wifi.ip}:${state.adb.port}`);
      if (serial) return this.remember(deviceId, serial);
    }
    // From anywhere: a local tunnel the link carries to the phone's debugging port.
    const port = await this.tunnelPort(deviceId);
    if (port) {
      const serial = await this.connect(adb.path, `127.0.0.1:${port}`);
      if (serial) return this.remember(deviceId, serial);
    }
    return undefined;
  }

  private remember(deviceId: string, serial: string): string {
    this.serials.set(deviceId, serial);
    return serial;
  }

  private async connect(adbPath: string, target: string): Promise<string | undefined> {
    const res = await this.deps.sys.exec(adbPath, ['connect', target], 10_000).catch(() => undefined);
    if (res && /connected to|already connected/i.test(res.stdout)) return target;
    this.logLine(`adb connect ${target}: ${(res?.stdout || res?.stderr || 'no answer').trim().slice(0, 120)}`);
    return undefined;
  }

  /** A USB serial for this phone, if one is plugged in (matched by the phone's model, best effort). */
  private async usbSerial(state: PhoneControlState | undefined): Promise<string | undefined> {
    const usb = (await this.attached()).filter((d) => d.usb && d.state === 'device');
    if (!usb.length) return undefined;
    if (usb.length === 1) return usb[0]!.serial;
    // More than one: match by model (`ro.product.model`) when we know it.
    const adb = this.adb;
    if (adb && state) {
      for (const d of usb) {
        const got = await this.deps.sys.exec(adb.path, ['-s', d.serial, 'shell', 'getprop', 'ro.product.model'], 6_000).catch(() => undefined);
        if (got?.stdout.trim() === state.device.model) return d.serial;
      }
    }
    return usb[0]!.serial;
  }

  /** Where the phone can be reached now, best route first. */
  async reach(deviceId: string): Promise<Reach | undefined> {
    const link = this.deps.link(deviceId);
    const state = link?.control;
    const adb = await this.ensureAdb();
    if (adb) {
      const usb = await this.usbSerial(state);
      if (usb) return { route: 'usb', adb: new Adb(this.deps.sys, adb.path, usb), ...(link ? { link } : {}) };
      const serial = state?.wifi?.ip ? await this.adbSerial(deviceId, state) : undefined;
      if (serial) return { route: serial.startsWith('127.0.0.1') ? 'link' : 'wifi', adb: new Adb(this.deps.sys, adb.path, serial), ...(link ? { link } : {}) };
      // Still try the tunnel even without a known Wi-Fi IP (debugging reachable only over the link).
      if (state?.adb.on && link) {
        const serial2 = await this.adbSerial(deviceId, state);
        if (serial2) return { route: 'link', adb: new Adb(this.deps.sys, adb.path, serial2), link };
      }
    }
    // No adb: the app's Accessibility service, if it's on and allowed.
    if (link?.control?.allowed && link.control.accessibility) return { route: 'accessibility', link };
    return undefined;
  }

  /** The routes available now, best first, for the view and the brief. */
  private routesOf(state: PhoneControlState | undefined, usb: boolean, wifi: boolean, tunnel: boolean): PhoneRoute[] {
    const routes: PhoneRoute[] = [];
    if (usb) routes.push('usb');
    if (wifi) routes.push('wifi');
    if (tunnel) routes.push('link');
    if (state?.allowed && state.accessibility) routes.push('accessibility');
    return routes;
  }

  /** One phone's control, for the Mac's screens (companion slice). */
  controlView(deviceId: string): PhoneControlView {
    const use = this.howUsed(deviceId);
    const link = this.deps.link(deviceId);
    const state = link?.control;
    const serial = this.serials.get(deviceId);
    const connected = Boolean(serial);
    const adbStage: PhoneControlView['adb'] = !state?.adb.on ? 'off' : connected ? 'connected' : state.adb.pairing ? 'unpaired' : 'ready';
    const usb = this.lastUsb.get(deviceId) ?? false;
    const routes = this.routesOf(state, usb, Boolean(state?.wifi?.ip) && connected && !serial?.startsWith('127.0.0.1'), connected && Boolean(serial?.startsWith('127.0.0.1')) || (state?.adb.on ?? false));
    return {
      use,
      ...(state ? { allowed: state.allowed, accessibility: state.accessibility, screenshots: state.screenshots } : {}),
      adb: adbStage,
      usb,
      routes: use === 'off' ? [] : routes,
      ...(serial ? { serial } : {}),
      ...(state?.device.model ? { model: state.device.model } : {}),
      ...(this.noteFor(state, routes, use) ? { note: this.noteFor(state, routes, use)! } : {}),
    };
  }
  private lastUsb = new Map<string, boolean>();

  private noteFor(state: PhoneControlState | undefined, routes: readonly PhoneRoute[], use: PhoneUse): string | undefined {
    if (use === 'off') return 'Off. Turn it on to let Claude act on this phone.';
    if (!state) return 'Open the Beluga app on this phone so it can say what it allows.';
    if (!state.allowed) return 'Turn on “Let your Mac use this phone” in the phone’s Beluga.';
    if (routes.length) return undefined;
    if (!state.accessibility && !state.adb.on) return 'On the phone: turn on Accessibility for Beluga, or Wireless debugging.';
    if (state.adb.on && state.adb.pairing) return 'Type the phone’s pairing code into Beluga’s notification to connect adb.';
    return 'Can’t reach the phone right now.';
  }

  // ---- the operations the tools use

  /** A screenshot: over adb when we have it (crisp PNG), else the Accessibility service (API 30+). */
  async screenshot(deviceId: string): Promise<{ image: Buffer; mime: 'image/png' | 'image/jpeg'; w: number; h: number }> {
    const r = await this.need(deviceId, 'look');
    if (r.adb) {
      const png = await r.adb.execOutBytes(['screencap', '-p'], 20_000);
      if (!png.length) throw new Error('The screenshot came back empty.');
      return { image: png, mime: 'image/png', w: 0, h: 0 };
    }
    const shot = (await r.link!.request('screenshot', {})) as { b64: string; mime: 'image/jpeg' | 'image/png'; w: number; h: number };
    return { image: Buffer.from(shot.b64, 'base64'), mime: shot.mime, w: shot.w, h: shot.h };
  }

  /** The screen as a labelled tree. Over the link it's the Accessibility tree; over adb, `uiautomator dump`. */
  async screen(deviceId: string): Promise<{ text: string; view?: ScreenView }> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control?.accessibility) {
      const view = (await r.link.request('screen', {})) as ScreenView;
      return { text: describeScreen(view), view };
    }
    if (r.adb) {
      const dump = await r.adb.shell('uiautomator dump /dev/tty 2>/dev/null; cat /sdcard/window_dump.xml 2>/dev/null', 20_000).catch(() => undefined);
      const xml = dump?.stdout?.includes('<hierarchy') ? dump.stdout : (await r.adb.shell('uiautomator dump && cat /sdcard/window_dump.xml', 20_000)).stdout;
      return { text: describeUiautomator(xml) };
    }
    throw new Error('Can’t read the screen on this phone right now.');
  }

  async tap(deviceId: string, a: { x: number; y: number; node?: number; gen?: number }): Promise<void> {
    await this.act(deviceId, 'tap', a, (adb) => adb.shell(`input tap ${a.x} ${a.y}`));
  }
  async longPress(deviceId: string, a: { x: number; y: number; ms?: number }): Promise<void> {
    await this.act(deviceId, 'long_press', a, (adb) => adb.shell(`input swipe ${a.x} ${a.y} ${a.x} ${a.y} ${a.ms ?? 600}`));
  }
  async swipe(deviceId: string, a: { x1: number; y1: number; x2: number; y2: number; ms?: number }): Promise<void> {
    await this.act(deviceId, 'swipe', a, (adb) => adb.shell(`input swipe ${a.x1} ${a.y1} ${a.x2} ${a.y2} ${a.ms ?? 300}`));
  }
  async type(deviceId: string, a: { text: string; replace?: boolean; enter?: boolean; node?: number; gen?: number }): Promise<void> {
    await this.act(deviceId, 'type', a, async (adb) => {
      if (a.replace) {
        // Select all and delete, then type (adb input has no "clear").
        await adb.shell('input keyevent KEYCODE_MOVE_END');
        await adb.shell('input keyevent --longpress $(printf "67 %.0s" {1..80})').catch(() => undefined);
      }
      const esc = a.text.replace(/(["\s$'`\\&|;<>()])/g, '\\$1');
      const res = await adb.shell(`input text "${esc}"`);
      if (a.enter) await adb.shell('input keyevent KEYCODE_ENTER');
      return res;
    });
  }
  async key(deviceId: string, key: string): Promise<void> {
    const code = ADB_KEYS[key];
    await this.act(deviceId, 'key', { key }, (adb) => (code ? adb.shell(`input keyevent ${code}`) : Promise.reject(new Error(`No adb key for ${key}`))));
  }
  async scroll(deviceId: string, a: { dir: 'up' | 'down' | 'left' | 'right'; node?: number; gen?: number }): Promise<void> {
    await this.act(deviceId, 'scroll', a, (adb) => adb.shell(scrollCommand(a.dir)));
  }
  async open(deviceId: string, a: { package?: string; url?: string }): Promise<string> {
    const r = await this.need(deviceId, 'act');
    if (r.adb) {
      const res = a.url ? await r.adb.shell(`am start -a android.intent.action.VIEW -d ${JSON.stringify(a.url)}`) : await r.adb.shell(`monkey -p ${a.package} -c android.intent.category.LAUNCHER 1`);
      if (res.code !== 0 && res.stderr.trim()) throw new Error(res.stderr.trim().slice(0, 200));
      return a.url ? `Opened ${a.url}` : `Opened ${a.package}`;
    }
    await r.link!.request('open', a);
    return a.url ? `Opened ${a.url}` : `Opened ${a.package}`;
  }
  async apps(deviceId: string): Promise<Array<{ pkg: string; label: string }>> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control) {
      const res = (await r.link.request('apps', {})) as { apps: Array<{ pkg: string; label: string }> };
      return res.apps;
    }
    const res = await r.adb!.shell('pm list packages -3');
    return res.stdout.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean).map((pkg) => ({ pkg, label: pkg }));
  }
  async info(deviceId: string): Promise<Record<string, unknown>> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control) return (await r.link.request('info', {})) as Record<string, unknown>;
    const model = (await r.adb!.shell('getprop ro.product.model')).stdout.trim();
    const android = (await r.adb!.shell('getprop ro.build.version.release')).stdout.trim();
    return { model, android };
  }

  /** A shell command on the phone (adb only). */
  async shell(deviceId: string, command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = await this.need(deviceId, 'shell');
    if (!r.adb) throw new Error('A shell command needs Wireless debugging (Accessibility can’t run commands).');
    return r.adb.shell(command, timeoutMs);
  }
  /** Recent logs (adb only). */
  async logcat(deviceId: string, args: readonly string[] = ['-d', '-t', '400']): Promise<string> {
    const r = await this.need(deviceId, 'shell');
    if (!r.adb) throw new Error('Reading logs needs Wireless debugging.');
    const safe = args.filter((a) => /^[\w:*.,=\/-]+$/.test(a)).slice(0, 12);
    return (await r.adb.run(['logcat', ...safe], 20_000)).stdout;
  }

  /** Send a file from this Mac to the phone (adb push); returns the on-device path (BLG-176). */
  async push(deviceId: string, localPath: string, dest = '/sdcard/Download/'): Promise<string> {
    const r = await this.need(deviceId, 'act');
    if (!r.adb) throw new Error('Sending a file to the phone needs Wireless debugging.');
    const res = await r.adb.run(['push', localPath, dest], 120_000);
    if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 200) || 'The push failed.');
    return dest.endsWith('/') ? dest + path.basename(localPath) : dest;
  }

  /** Get a file from the phone to a folder on this Mac (adb pull); returns the local path (BLG-176). */
  async pull(deviceId: string, remotePath: string, intoDir: string): Promise<string> {
    const r = await this.need(deviceId, 'look');
    if (!r.adb) throw new Error('Getting a file from the phone needs Wireless debugging.');
    await fs.mkdir(intoDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const local = path.join(intoDir, path.basename(remotePath) || 'file');
    const res = await r.adb.run(['pull', remotePath, local], 120_000);
    if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 200) || 'The pull failed.');
    return local;
  }

  /** The phone's current notifications (adb dumpsys, best-effort parse; BLG-176). */
  async notifications(deviceId: string): Promise<Array<{ app: string; title: string; text: string }>> {
    const r = await this.need(deviceId, 'look');
    if (!r.adb) throw new Error('Reading notifications needs Wireless debugging.');
    const out = await r.adb.shell('dumpsys notification --noredact', 15_000);
    return parseNotifications(out.stdout);
  }

  /** The adb serial for this phone's Bash, so `adb -s <serial>` and scrcpy work; or undefined. */
  async serialFor(deviceId: string): Promise<{ serial: string; adbPath: string } | undefined> {
    const r = await this.reach(deviceId);
    return r?.adb ? { serial: r.adb.serial, adbPath: r.adb.adbPath } : undefined;
  }

  /**
   * Environment for the owner's runs (BLG-174) so Claude's Bash can use adb and scrcpy against the
   * phone with no setup: adb on PATH, and ANDROID_SERIAL when this phone's serial is already known
   * (with one phone attached, adb needs no serial anyway). Synchronous and best-effort — it never
   * blocks a run; a `phone_status` or any phone tool first will have cached the serial.
   */
  runEnv(): Record<string, string> {
    const dir = this.adbDirSync();
    if (!dir) return {};
    const env: Record<string, string> = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
    const id = this.targetDevice();
    const serial = id ? this.serials.get(id) : undefined;
    if (serial) env.ANDROID_SERIAL = serial;
    return env;
  }

  /** adb's folder, found without the async probe (the cached one, or the first that exists on disk). */
  private adbDirSync(): string | undefined {
    if (this.adb) return path.dirname(this.adb.path);
    if (this.deps.adbPath) return path.dirname(this.deps.adbPath);
    const hit = adbCandidates(this.deps.home).find((p) => existsSync(p));
    return hit ? path.dirname(hit) : undefined;
  }

  /**
   * A live mirror of the phone's screen (BLG-173): repeatedly grabs a frame and hands it to
   * `onFrame`, at about `fps`, until the returned stop() is called. Over adb it's a full-resolution
   * `screencap` PNG (crisp, the webview decodes it straight); over the Accessibility link it's a
   * downscaled JPEG at a gentler rate. One grab is in flight at a time, so a slow phone just lowers
   * the frame rate rather than piling up.
   */
  startMirror(
    deviceId: string,
    opts: { fps?: number; max?: number },
    onFrame: (f: { b64: string; mime: string; w: number; h: number }) => void,
    onStatus: (s: { on: boolean; route?: PhoneRoute; error?: string }) => void,
  ): () => void {
    let stopped = false;
    const fps = Math.min(opts.fps ?? 6, 30);
    const interval = 1000 / fps;
    const loop = async (): Promise<void> => {
      let lastRoute: PhoneRoute | undefined;
      while (!stopped) {
        const started = Date.now();
        try {
          const r = await this.reach(deviceId);
          if (!r) throw new Error(this.noteFor(this.deps.link(deviceId)?.control, [], this.howUsed(deviceId)) ?? 'The phone isn’t reachable');
          if (r.route !== lastRoute) {
            lastRoute = r.route;
            onStatus({ on: true, route: r.route });
          }
          if (r.adb) {
            const png = await r.adb.execOutBytes(['screencap', '-p'], 8_000);
            if (png.length) {
              const dim = pngSize(png);
              onFrame({ b64: png.toString('base64'), mime: 'image/png', w: dim?.w ?? 0, h: dim?.h ?? 0 });
            }
          } else if (r.link) {
            const shot = (await r.link.request('screenshot', { max: opts.max ?? 900, quality: 55 }, 8_000)) as { b64: string; mime: 'image/jpeg' | 'image/png'; w: number; h: number };
            onFrame({ b64: shot.b64, mime: shot.mime, w: shot.w, h: shot.h });
          }
        } catch (err) {
          if (stopped) break;
          onStatus({ on: false, error: err instanceof Error ? err.message : String(err) });
          // Back off a little before trying again (the phone slept, the route dropped).
          await delay(1200);
          continue;
        }
        const wait = interval - (Date.now() - started);
        if (wait > 0) await delay(wait);
      }
    };
    void loop();
    return () => {
      stopped = true;
      onStatus({ on: false });
    };
  }

  /** One action for the Mac UI (the mirror's tap/type/scroll, or a button), by op. */
  async action(deviceId: string, op: PhoneOp, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'tap':
        return this.tap(deviceId, args as { x: number; y: number; node?: number });
      case 'long_press':
        return this.longPress(deviceId, args as { x: number; y: number; ms?: number });
      case 'swipe':
        return this.swipe(deviceId, args as { x1: number; y1: number; x2: number; y2: number; ms?: number });
      case 'type':
        return this.type(deviceId, args as { text: string; replace?: boolean; enter?: boolean });
      case 'key':
        return this.key(deviceId, String((args as { key: string }).key));
      case 'scroll':
        return this.scroll(deviceId, args as { dir: 'up' | 'down' | 'left' | 'right' });
      case 'open':
        return this.open(deviceId, args as { package?: string; url?: string });
      default:
        throw new Error(`Can’t do ${op} from here`);
    }
  }

  // ---- helpers

  /** The reach for an action of this kind, after the use level has allowed it. */
  private async need(deviceId: string, kind: 'look' | 'act' | 'shell'): Promise<Reach> {
    const use = this.howUsed(deviceId);
    if (use === 'off') throw new Error('This phone is off for Claude (turn it on in Settings › Phone).');
    const r = await this.reach(deviceId);
    if (!r) throw new Error(this.noteFor(this.deps.link(deviceId)?.control, [], use) ?? 'Can’t reach this phone right now.');
    return r;
  }

  /** Do an acting op by the route we have: adb when present, else the Accessibility service. */
  private async act(deviceId: string, op: PhoneOp, args: Record<string, unknown>, viaAdb: (adb: Adb) => Promise<{ code: number; stderr: string } | void>): Promise<void> {
    const r = await this.need(deviceId, 'act');
    // A node of the last screen is only meaningful to the Accessibility service: prefer the link then.
    const preferLink = typeof args.node === 'number' && r.link?.control?.accessibility;
    if (r.adb && !preferLink && !OP_NEEDS_ADB.has(op)) {
      const res = await viaAdb(r.adb);
      if (res && res.code !== 0 && res.stderr.trim()) throw new Error(res.stderr.trim().slice(0, 200));
      return;
    }
    if (!r.link?.control?.accessibility) throw new Error('Can’t act on this phone right now.');
    await r.link.request(op, args);
  }

  /** The local adb-over-link tunnel's port for a phone (started on demand), or undefined. */
  private async tunnelPort(deviceId: string): Promise<number | undefined> {
    const existing = this.tunnels.get(deviceId);
    if (existing) return existing.port;
    const link = this.deps.link(deviceId);
    if (!link?.control?.adb.on) return undefined;
    const port = await this.startTunnel(deviceId).catch((err: unknown) => {
      this.logLine(`tunnel for ${deviceId}: ${String(err)}`);
      return undefined;
    });
    return port;
  }

  /**
   * A local TCP server on 127.0.0.1: every connection the Mac's adb makes opens a byte tunnel to the
   * phone's debugging port through the link (the phone's worklet dials its own adbd). adb's own TLS
   * stays end to end between adb and adbd; the link only carries the ciphertext.
   */
  private startTunnel(deviceId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const link = this.deps.link(deviceId);
        if (!link) return socket.destroy();
        let allowed = TUN_WINDOW;
        const end = link.openTunnel('adb', {
          onOpen: () => socket.resume(),
          onData: (bytes) => {
            if (!socket.write(bytes)) socket.pause();
          },
          onClose: (error) => socket.destroy(error ? new Error(error) : undefined),
          onAck: (n) => {
            allowed += n;
            if (allowed > 0) socket.resume();
          },
        });
        socket.on('data', (chunk: Buffer) => {
          end.send(chunk);
          allowed -= chunk.length;
          if (allowed <= 0) socket.pause();
        });
        socket.on('drain', () => socket.resume());
        socket.on('close', () => end.close());
        socket.on('error', () => end.close('socket error'));
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        if (!port) return reject(new Error('No local port for the adb tunnel'));
        this.tunnels.set(deviceId, { server, port });
        resolve(port);
      });
    });
  }

  /** Pair the Mac's adb with the phone, using a code the phone sent (over the pairing-port tunnel). */
  async pairAdb(deviceId: string): Promise<string> {
    const adb = await this.ensureAdb();
    if (!adb) throw new Error('adb isn’t installed on this Mac.');
    const link = this.deps.link(deviceId);
    const code = link?.adbCode?.code;
    const pairPort = link?.control?.adb.pairing;
    if (!code || !pairPort) throw new Error('Open “Pair with code” on the phone and type the six digits into Beluga’s notification.');
    // A tunnel to the pairing port; adb pairs over it.
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const end = link!.openTunnel('adb-pair', {
          onOpen: () => socket.resume(),
          onData: (b) => void socket.write(b),
          onClose: (e) => socket.destroy(e ? new Error(e) : undefined),
          onAck: () => undefined,
        });
        socket.on('data', (c: Buffer) => end.send(c));
        socket.on('close', () => end.close());
        socket.on('error', () => end.close());
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
        setTimeout(() => server.close(), 30_000).unref();
      });
    });
    const res = await this.deps.sys.exec(adb.path, ['pair', `127.0.0.1:${port}`, code], 20_000);
    if (!/Successfully paired/i.test(res.stdout)) throw new Error(res.stdout.trim() || res.stderr.trim() || 'Pairing didn’t go through.');
    this.deps.onChange();
    return 'Paired. Connecting…';
  }

  /** A phone said new control, went away, or its code came: recompute and publish. */
  touched(deviceId: string, usb?: boolean): void {
    if (usb !== undefined) this.lastUsb.set(deviceId, usb);
    this.deps.onChange();
  }

  /** Close everything for a phone that's gone or was removed. */
  forget(deviceId: string): void {
    const t = this.tunnels.get(deviceId);
    if (t) {
      t.server.close();
      this.tunnels.delete(deviceId);
    }
    this.serials.delete(deviceId);
    this.lastUsb.delete(deviceId);
  }

  stop(): void {
    for (const { server } of this.tunnels.values()) server.close();
    this.tunnels.clear();
  }

  /** The phone Claude should act on: an Android one the owner turned on, a linked one first. */
  targetDevice(): string | undefined {
    const on = this.deps.devices
      .all()
      .filter((r) => r.cert.platform === 'android' && (r.use ?? 'off') !== 'off')
      .map((r) => r.cert.device.slice(0, 16));
    if (!on.length) return undefined;
    return on.find((id) => this.deps.link(id)) ?? on[0];
  }

  /** A line for the tools and the brief: which phone and how it's reached now. */
  summaryLine(deviceId: string): string {
    const v = this.controlView(deviceId);
    const name = this.deps.devices.get(deviceId)?.cert.name ?? 'your phone';
    const how = v.routes.length ? `reached by ${v.routes[0] === 'accessibility' ? 'the Accessibility service' : v.routes[0] === 'link' ? 'Wireless debugging (through the link)' : v.routes[0] === 'wifi' ? 'Wireless debugging (same Wi-Fi)' : 'USB'}` : (v.note ?? 'not reachable right now');
    const shell = v.routes.some((x) => x === 'usb' || x === 'wifi' || x === 'link');
    return `${name} (${v.model ?? 'Android'}) — ${how}.${shell ? ' Shell, logs and installs work.' : ' Taps, typing and screenshots only (no shell/logs: turn on Wireless debugging for those).'}`;
  }

  /**
   * The agent's tools for the owner's own runs (server beluga_phone). Returns undefined when no
   * phone is turned on. `scratchDir` (absolute): where a screenshot is saved so it shows as an
   * output on both screens.
   */
  toolsFor(scratchDir?: string): { tools: PhoneTools; brief: string; deviceId: string; env: Record<string, string> } | undefined {
    const deviceId = this.targetDevice();
    if (!deviceId) return undefined;
    // Warm the route so the serial is cached for this run's Bash adb (fire-and-forget).
    void this.reach(deviceId).catch(() => undefined);
    const ctl = this;
    const ok = (text: string): string => text;
    const tools: PhoneTools = {
      status: async () => ctl.summaryLine(deviceId),
      screenshot: async () => {
        const shot = await ctl.screenshot(deviceId);
        let saved = '';
        if (scratchDir) {
          await fs.mkdir(scratchDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
          const name = `phone-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`;
          await fs.writeFile(path.join(scratchDir, name), shot.image).catch(() => undefined);
          saved = ` Saved as ${name}.`;
        }
        return { text: `Screenshot of the phone.${saved} Say in a line what it shows.`, image: { data: shot.image.toString('base64'), mimeType: shot.mime } };
      },
      screen: async () => (await ctl.screen(deviceId)).text,
      tap: async (a) => (await ctl.tap(deviceId, a), ok(`Tapped ${a.node !== undefined ? `#${a.node}` : `${a.x},${a.y}`}.`)),
      swipe: async (a) => (await ctl.swipe(deviceId, a), ok('Swiped.')),
      type: async (a) => (await ctl.type(deviceId, a), ok(`Typed${a.enter ? ' and pressed enter' : ''}.`)),
      key: async (key) => (await ctl.key(deviceId, key), ok(`Pressed ${key}.`)),
      scroll: async (a) => (await ctl.scroll(deviceId, a), ok(`Scrolled ${a.dir}.`)),
      open: async (a) => ctl.open(deviceId, a),
      apps: async () => {
        const list = await ctl.apps(deviceId);
        return list.map((x) => `${x.label}${x.label === x.pkg ? '' : ` (${x.pkg})`}`).join('\n') || 'No apps listed.';
      },
      info: async () => {
        const i = await ctl.info(deviceId);
        return Object.entries(i).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
      },
      install: async (apkPath) => {
        const r = await ctl.need(deviceId, 'act');
        if (r.adb) {
          const res = await r.adb.run(['install', '-r', apkPath], 120_000);
          if (!/Success/i.test(res.stdout)) throw new Error(res.stderr.trim() || res.stdout.trim() || 'Install failed.');
          return 'Installed.';
        }
        throw new Error('Installing over the Accessibility service isn’t supported yet; turn on Wireless debugging.');
      },
      shell: async (command) => {
        const res = await ctl.shell(deviceId, command);
        return `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`.trim() || `(no output, exit ${res.code})`;
      },
      logcat: async (filter) => ctl.logcat(deviceId, filter ? filter.split(/\s+/) : undefined),
      push: async (localPath, dest) => `Sent to the phone at ${await ctl.push(deviceId, localPath, dest)}`,
      pull: async (remotePath) => {
        if (!scratchDir) throw new Error('No scratch folder to save into');
        const local = await ctl.pull(deviceId, remotePath, scratchDir);
        return `Saved from the phone as ${path.basename(local)} (an output).`;
      },
      notifications: async () => {
        const list = await ctl.notifications(deviceId);
        return list.length ? list.map((n) => `• ${n.title || n.app}${n.text ? ` — ${n.text}` : ''}  [${n.app}]`).join('\n') : 'No notifications right now.';
      },
    };
    return { tools, brief: phoneBrief(`- Now: ${this.summaryLine(deviceId)}`), deviceId, env: this.runEnv() };
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/** `dumpsys notification --noredact` → the active notifications (best-effort: pkg, title, text). */
export function parseNotifications(dump: string): Array<{ app: string; title: string; text: string }> {
  const out: Array<{ app: string; title: string; text: string }> = [];
  // Each record block starts with `NotificationRecord(... pkg=<pkg> ...)`; titles/texts are `android.title=String (...)`.
  const blocks = dump.split(/NotificationRecord\(/).slice(1);
  for (const block of blocks.slice(0, 60)) {
    const app = /pkg=([\w.]+)/.exec(block)?.[1];
    if (!app) continue;
    const title = /android\.title=String \(([^)]*)\)/.exec(block)?.[1] ?? /tickerText=([^\n]+)/.exec(block)?.[1];
    const text = /android\.text=String \(([^)]*)\)/.exec(block)?.[1] ?? /android\.text=CharSequence \(([^)]*)\)/.exec(block)?.[1];
    if (title || text) out.push({ app, title: (title ?? '').trim().slice(0, 200), text: (text ?? '').trim().slice(0, 500) });
  }
  return out;
}

/** A PNG's pixel size from its IHDR (bytes 16–23, big-endian); undefined if it isn't a PNG. */
function pngSize(png: Buffer): { w: number; h: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** Android key codes for the buttons a phone has (adb `input keyevent`). */
const ADB_KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  notifications: 'KEYCODE_NOTIFICATION',
  enter: 'KEYCODE_ENTER',
  lock: 'KEYCODE_POWER',
};

function scrollCommand(dir: 'up' | 'down' | 'left' | 'right'): string {
  // A swipe across the middle of a 1080×2400-ish screen; the phone clamps to its real size.
  const mid = { x: 540, y: 1200 };
  const d = 700;
  if (dir === 'up') return `input swipe ${mid.x} ${mid.y - d} ${mid.x} ${mid.y + d} 300`;
  if (dir === 'down') return `input swipe ${mid.x} ${mid.y + d} ${mid.x} ${mid.y - d} 300`;
  if (dir === 'left') return `input swipe ${mid.x - d} ${mid.y} ${mid.x + d} ${mid.y} 300`;
  return `input swipe ${mid.x + d} ${mid.y} ${mid.x - d} ${mid.y} 300`;
}

/** The Accessibility screen as lines Claude can read and act on (its node numbers are tappable). */
export function describeScreen(view: ScreenView): string {
  const lines = [`App: ${view.app} · ${view.w}×${view.h}${view.keyboard ? ' · keyboard up' : ''}`];
  for (const w of view.windows ?? []) lines.push(`Window: ${w.type}${w.title ? ` "${w.title}"` : ''} (${w.app})`);
  for (const n of view.nodes) {
    const flags = n.f ?? '';
    const says = n.t || n.s || n.h || '';
    const can = [flags.includes('c') && 'tap', flags.includes('e') && 'type', flags.includes('s') && 'scroll'].filter(Boolean).join(',');
    if (!says && !can) continue;
    const [l, t, r, b] = n.b;
    lines.push(`#${n.i} ${n.c}${says ? ` "${says.slice(0, 80)}"` : ''}${n.r ? ` [${n.r}]` : ''}${can ? ` (${can})` : ''} @${Math.round((l + r) / 2)},${Math.round((t + b) / 2)}`);
  }
  return lines.join('\n');
}

/** `uiautomator dump` XML as the same kind of lines (used when adb is driving and the app isn't). */
export function describeUiautomator(xml: string): string {
  const nodes: string[] = [];
  let i = 0;
  const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    if (i >= 400) break;
    const tag = m[0];
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!bounds) continue;
    const text = attr(tag, 'text') ?? '';
    const desc = attr(tag, 'content-desc') ?? '';
    const clickable = attr(tag, 'clickable') === 'true';
    const says = text || desc;
    if (!says && !clickable) continue;
    const cls = (attr(tag, 'class') ?? '').split('.').pop();
    const rid = attr(tag, 'resource-id');
    const cx = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
    const cy = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
    nodes.push(`#${i++} ${cls}${says ? ` "${says.slice(0, 80)}"` : ''}${rid ? ` [${rid.split('/').pop()}]` : ''}${clickable ? ' (tap)' : ''} @${cx},${cy}`);
  }
  return nodes.length ? nodes.join('\n') : 'The screen has no labelled elements right now (try a screenshot).';
}
