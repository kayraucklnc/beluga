import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a friend's Claude may look at on this Mac when you allow it (Settings › What your
 * friends' Claudes can do here): a screenshot of the main display or of one app's window, and a
 * summary of the device. Read-only, nothing secret: no serial numbers, MAC addresses, Wi-Fi
 * names, host names or anything from other apps. Everything the system is asked goes through
 * a SystemPort, so tests never touch the real screen.
 */

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SystemPort {
  exec(cmd: string, args: readonly string[], timeoutMs?: number): Promise<ExecResult>;
  readdir(dir: string): Promise<readonly string[]>;
  readonly os: Pick<typeof os, 'platform' | 'release' | 'cpus' | 'totalmem' | 'freemem' | 'networkInterfaces' | 'uptime' | 'arch' | 'homedir'>;
}

export const realSystem: SystemPort = {
  exec: (cmd, args, timeoutMs = 15_000) =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
      });
    }),
  readdir: (dir) => fs.readdir(dir).catch(() => []),
  os,
};

// ------------------------------------------------------------------ the screen

export interface WindowInfo {
  readonly id: number;
  readonly app: string;
  readonly title: string;
}

/** On-screen app windows, front to back (asked of CoreGraphics through JavaScript for Automation). */
const WINDOWS_JXA = `ObjC.import('CoreGraphics');
var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
JSON.stringify(list.filter(function (w) { return w.kCGWindowLayer === 0; }).map(function (w) { return { id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '' }; }));`;

export async function listWindows(sys: SystemPort): Promise<WindowInfo[]> {
  const res = await sys.exec('osascript', ['-l', 'JavaScript', '-e', WINDOWS_JXA], 10_000);
  if (res.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout.trim()) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((w) => (w && typeof w === 'object' && typeof (w as WindowInfo).id === 'number' && typeof (w as WindowInfo).app === 'string' ? [{ id: (w as WindowInfo).id, app: (w as WindowInfo).app, title: String((w as WindowInfo).title ?? '').slice(0, 200) }] : []))
      : [];
  } catch {
    return [];
  }
}

export interface Screenshot {
  /** The full picture (PNG), in the task's folder. */
  readonly file: string;
  readonly bytes: number;
  /** A smaller JPEG for Claude to look at (missing: it couldn't be made). */
  readonly view?: string;
  /** What it shows: "the main display", "Safari's window". */
  readonly of: string;
}

const MAX_VIEW_BYTES = 3_500_000;

/**
 * Take a screenshot without a sound (`screencapture -x`): the main display, or the front window
 * of one app. Fails clearly when there's no screen to capture or macOS hasn't allowed it.
 */
export async function captureScreen(sys: SystemPort, dir: string, opts: { app?: string } = {}): Promise<Screenshot> {
  if (sys.os.platform() !== 'darwin') throw new Error('Screenshots only work on a Mac');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  let target: string[] = ['-m'];
  let of = 'the main display';
  if (opts.app) {
    const wanted = opts.app.trim().toLowerCase();
    const windows = await listWindows(sys);
    const win = windows.find((w) => w.app.toLowerCase() === wanted) ?? windows.find((w) => w.app.toLowerCase().includes(wanted));
    if (!win) throw new Error(`No open window of ${opts.app} on screen`);
    target = [`-l${win.id}`, '-o'];
    of = `${win.app}'s window`;
  }
  const file = path.join(dir, `screen-${stamp}${opts.app ? `-${opts.app.replace(/[^\w-]+/g, '_').slice(0, 30)}` : ''}.png`);
  const res = await sys.exec('screencapture', ['-x', '-t', 'png', ...target, file], 20_000);
  const stat = await fs.stat(file).catch(() => undefined);
  if (res.code !== 0 || !stat?.size) {
    throw new Error(`The screenshot didn't work${res.stderr.trim() ? `: ${res.stderr.trim().slice(0, 200)}` : ''}. macOS may need klaud allowed in System Settings › Privacy & Security › Screen Recording.`);
  }
  // A smaller copy for Claude's eyes (the PNG of a Retina display is several MB).
  const view = file.replace(/\.png$/, '-view.jpg');
  const shrunk = await sys.exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '1568', file, '--out', view], 20_000);
  const viewStat = shrunk.code === 0 ? await fs.stat(view).catch(() => undefined) : undefined;
  return { file, bytes: stat.size, of, ...(viewStat?.size && viewStat.size <= MAX_VIEW_BYTES ? { view } : stat.size <= MAX_VIEW_BYTES ? { view: file } : {}) };
}

// ------------------------------------------------------------------ the device

export interface DeviceInfo {
  readonly os: string;
  readonly model?: string;
  readonly chip?: string;
  readonly cpus: number;
  readonly arch: string;
  readonly memory: { readonly totalGB: number; readonly freeGB: number };
  readonly disk?: { readonly totalGB: number; readonly freeGB: number };
  readonly battery?: { readonly percent?: number; readonly charging?: boolean; readonly power: string; readonly remaining?: string };
  readonly uptimeHours: number;
  readonly network: ReadonlyArray<{ readonly interface: string; readonly addresses: readonly string[] }>;
  readonly apps: readonly string[];
}

const GB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** `df -k` output → total and free space of its first volume. */
export function parseDf(text: string): { totalGB: number; freeGB: number } | undefined {
  const line = text.trim().split('\n')[1];
  const cols = line?.trim().split(/\s+/);
  const total = Number(cols?.[1]);
  const free = Number(cols?.[3]);
  return Number.isFinite(total) && Number.isFinite(free) && total > 0 ? { totalGB: round1((total * 1024) / GB), freeGB: round1((free * 1024) / GB) } : undefined;
}

/** `pmset -g batt` output → the battery, or undefined on a Mac without one. */
export function parseBattery(text: string): DeviceInfo['battery'] {
  const power = /drawing from '([^']+)'/.exec(text)?.[1];
  const line = text.split('\n').find((l) => /InternalBattery/.test(l));
  if (!line) return undefined;
  const percent = Number(/(\d+)%/.exec(line)?.[1]);
  const state = /;\s*([a-zA-Z ]+);/.exec(line)?.[1]?.trim();
  const remaining = /(\d+:\d+) remaining/.exec(line)?.[1];
  return { power: power ?? 'unknown', ...(Number.isFinite(percent) ? { percent } : {}), ...(state ? { charging: state === 'charging' || state === 'charged' || state === 'finishing charge' } : {}), ...(remaining ? { remaining } : {}) };
}

/** Local addresses by interface (no MAC addresses, nothing from outside this Mac). */
export function localNetwork(ifaces: ReturnType<typeof os.networkInterfaces>): DeviceInfo['network'] {
  return Object.entries(ifaces)
    .flatMap(([name, list]) => {
      const addresses = (list ?? []).filter((a) => !a.internal && !(a.family === 'IPv6' && a.address.startsWith('fe80'))).map((a) => a.address);
      return addresses.length ? [{ interface: name, addresses }] : [];
    })
    .slice(0, 12);
}

/** A summary of this Mac: what a friend's Claude may read with the device capability. */
export async function deviceInfo(sys: SystemPort): Promise<DeviceInfo> {
  const [ver, build, hw, df, batt, apps, userApps] = await Promise.all([
    sys.exec('sw_vers', ['-productVersion']),
    sys.exec('sw_vers', ['-buildVersion']),
    sys.exec('system_profiler', ['-json', 'SPHardwareDataType'], 20_000),
    sys.exec('df', ['-k', '/System/Volumes/Data']),
    sys.exec('pmset', ['-g', 'batt']),
    sys.readdir('/Applications'),
    sys.readdir(path.join(sys.os.homedir(), 'Applications')),
  ]);
  let model: string | undefined;
  let chip: string | undefined;
  try {
    // Only the model and chip: the same report holds the serial number, which stays here.
    const item = (JSON.parse(hw.stdout) as { SPHardwareDataType?: Array<Record<string, unknown>> }).SPHardwareDataType?.[0] ?? {};
    model = typeof item.machine_name === 'string' ? item.machine_name : undefined;
    chip = typeof item.chip_type === 'string' ? item.chip_type : typeof item.cpu_type === 'string' ? item.cpu_type : undefined;
  } catch {
    // No profiler output: the processor's name below still says a lot.
  }
  const cpus = sys.os.cpus();
  const version = ver.code === 0 ? ver.stdout.trim() : '';
  const osLine = sys.os.platform() === 'darwin' && version ? `macOS ${version}${build.code === 0 && build.stdout.trim() ? ` (${build.stdout.trim()})` : ''}` : `${sys.os.platform()} ${sys.os.release()}`;
  const appNames = [...new Set([...apps, ...userApps].filter((n) => n.endsWith('.app')).map((n) => n.slice(0, -4)))].sort((a, b) => a.localeCompare(b)).slice(0, 300);
  const disk = df.code === 0 ? parseDf(df.stdout) : undefined;
  const battery = batt.code === 0 ? parseBattery(batt.stdout) : undefined;
  return {
    os: osLine,
    ...(model ? { model } : {}),
    ...((chip ?? cpus[0]?.model) ? { chip: chip ?? cpus[0]!.model } : {}),
    cpus: cpus.length,
    arch: sys.os.arch(),
    memory: { totalGB: round1(sys.os.totalmem() / GB), freeGB: round1(sys.os.freemem() / GB) },
    ...(disk ? { disk } : {}),
    ...(battery ? { battery } : {}),
    uptimeHours: round1(sys.os.uptime() / 3600),
    network: localNetwork(sys.os.networkInterfaces()),
    apps: appNames,
  };
}

/** The same in a few lines (what Claude reads first). */
export function describeDevice(d: DeviceInfo): string {
  const lines = [
    `${d.model ?? 'Mac'}${d.chip ? ` · ${d.chip}` : ''} · ${d.cpus} cores · ${d.memory.totalGB} GB memory (${d.memory.freeGB} GB free)`,
    `${d.os}, up ${d.uptimeHours} h`,
    d.disk ? `Disk: ${d.disk.freeGB} GB free of ${d.disk.totalGB} GB` : '',
    d.battery ? `Battery: ${d.battery.percent ?? '?'}%${d.battery.charging ? ', charging' : ''} (${d.battery.power}${d.battery.remaining ? `, ${d.battery.remaining} left` : ''})` : 'No battery (or not reported)',
    d.network.length ? `Network: ${d.network.map((n) => `${n.interface} ${n.addresses.join(', ')}`).join('; ')}` : 'Network: no local addresses',
    `${d.apps.length} apps in /Applications${d.apps.length ? `: ${d.apps.slice(0, 40).join(', ')}${d.apps.length > 40 ? ', …' : ''}` : ''}`,
  ];
  return lines.filter(Boolean).join('\n');
}
