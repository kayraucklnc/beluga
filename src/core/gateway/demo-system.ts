import { copyFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import type { ExecResult, SystemPort } from './device.js';

/**
 * A pretend Mac for the demo and the tests: screenshots are a generated picture (the real
 * screen is never captured), device info is made up, nothing runs on the system.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A PNG of a pretend desktop: a window on a gradient. `noise` adds pixels that don't compress,
 * to make a big file (the tests' screenshots bigger than a result can carry inline).
 */
export function pretendScreenshot(width = 960, height = 600, noise = false): Buffer {
  const rows: Buffer[] = [];
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const inWindow = x > width * 0.15 && x < width * 0.85 && y > height * 0.15 && y < height * 0.85;
      const bar = inWindow && y < height * 0.22;
      let r = inWindow ? (bar ? 228 : 250) : 70 + Math.round((x / width) * 60);
      let g = inWindow ? (bar ? 228 : 250) : 90 + Math.round((y / height) * 50);
      let b = inWindow ? (bar ? 232 : 252) : 160;
      if (noise) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        r ^= seed & 0x1f;
        g ^= (seed >> 5) & 0x1f;
        b ^= (seed >> 10) & 0x1f;
      }
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

export interface PretendSystem extends SystemPort {
  /** Every command it was asked to run, as "cmd arg arg". */
  readonly ran: string[];
}

/** A pretend Mac (see the top of this file); `big` makes screenshots several MB. */
export function pretendSystem(opts: { big?: boolean } = {}): PretendSystem {
  const ran: string[] = [];
  return {
    ran,
    os: {
      platform: () => 'darwin',
      release: () => '25.5.0',
      arch: () => 'arm64',
      cpus: () => Array.from({ length: 10 }, () => ({ model: 'Apple M4', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
      totalmem: () => 24 * 1024 ** 3,
      freemem: () => 9.5 * 1024 ** 3,
      uptime: () => 3 * 86_400 + 4 * 3600,
      homedir: () => os.tmpdir(),
      networkInterfaces: () => ({
        lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
        en0: [
          { address: '192.168.1.24', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.24/24' },
          { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fe80::1/64', scopeid: 4 },
        ],
      }),
    },
    readdir: async (dir) => (dir === '/Applications' ? ['Safari.app', 'Xcode.app', 'Figma.app', 'Klaud.app', '.DS_Store', 'Utilities'] : []),
    exec: async (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      if (cmd === 'screencapture') {
        writeFileSync(args[args.length - 1]!, pretendScreenshot(opts.big ? 1400 : 960, opts.big ? 900 : 600, Boolean(opts.big)));
        return ok();
      }
      if (cmd === 'sips') {
        // A "smaller copy": the same picture is fine here.
        copyFileSync(args[args.indexOf('--out') - 1]!, args[args.indexOf('--out') + 1]!);
        return ok();
      }
      if (cmd === 'osascript') return ok(JSON.stringify([{ id: 4242, app: 'Safari', title: 'Staging' }, { id: 77, app: 'Klaud', title: '' }]));
      if (cmd === 'sw_vers') return ok(args[0] === '-productVersion' ? '26.5\n' : '25F71\n');
      if (cmd === 'system_profiler') return ok(JSON.stringify({ SPHardwareDataType: [{ machine_name: 'MacBook Pro', chip_type: 'Apple M4 Pro', serial_number: 'C02SECRET123' }] }));
      if (cmd === 'df') return ok('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 512000000 412000000 56% /System/Volumes/Data\n');
      if (cmd === 'pmset') return ok("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t82%; discharging; 5:12 remaining present: true\n");
      return { code: 1, stdout: '', stderr: `${cmd}: not in the pretend Mac` };
    },
  };
}
