import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ExecBytesResult, ExecResult, SystemPort } from '../src/core/gateway/device.js';
import { adbCandidates, parseDevices } from '../src/companion/phone-adb.js';
import { PhoneControl, type PhoneLinkHandle, describeScreen, describeUiautomator } from '../src/companion/phone-control.js';
import { DeviceBook, type DeviceRecord } from '../src/companion/devices.js';
import type { DeviceCert, PhoneControl as PhoneControlState, PhoneOp, ScreenView } from '../src/companion/protocol.js';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';

/** A fake adb: exec/execBytes answer from scripted matchers (first whose args match the join). */
function fakeSys(script: Array<{ match: RegExp; out?: string; code?: number; bytes?: Buffer }>): { sys: SystemPort; calls: string[] } {
  const calls: string[] = [];
  const answer = (args: readonly string[]): { out: string; code: number; bytes?: Buffer } => {
    const line = args.join(' ');
    calls.push(line);
    const hit = script.find((s) => s.match.test(line));
    return { out: hit?.out ?? '', code: hit?.code ?? 0, ...(hit?.bytes ? { bytes: hit.bytes } : {}) };
  };
  const sys: SystemPort = {
    exec: (_cmd, args): Promise<ExecResult> => {
      const a = answer(args);
      return Promise.resolve({ code: a.code, stdout: a.out, stderr: '' });
    },
    execBytes: (_cmd, args): Promise<ExecBytesResult> => {
      const a = answer(args);
      return Promise.resolve({ code: a.code, stdout: a.bytes ?? Buffer.from(a.out), stderr: Buffer.alloc(0) });
    },
    readdir: () => Promise.resolve([]),
    os: { ...os, homedir: () => '/Users/test' },
  };
  return { sys, calls };
}

function cert(device: string, platform: 'android' | 'ios' = 'android'): DeviceCert {
  return { v: 1, owner: 'me', ownerKey: 'k', device: device.padEnd(64, '0'), link: device.padEnd(64, '1'), box: device.padEnd(64, '2'), name: 'Test Phone', platform, issuedAt: 1, sig: 's' };
}

function book(records: DeviceRecord[]): DeviceBook {
  const b = new DeviceBook(path.join(mkdtempSync(path.join(os.tmpdir(), 'dev-')), 'devices.json'));
  for (const r of records) (b as unknown as { list: DeviceRecord[]; save(x: readonly DeviceRecord[]): void }).save([...(b.all()), r]);
  return b;
}

const control = (over: Partial<PhoneControlState> = {}): PhoneControlState => ({
  allowed: true,
  accessibility: true,
  screenshots: true,
  adb: { on: false },
  device: { model: 'Pixel 9', manufacturer: 'Google', android: '15', sdk: 35, w: 1080, h: 2400 },
  ...over,
});

/** A fake link whose requests record the op and return a scripted value. */
function fakeLink(id: string, state: PhoneControlState | undefined, onReq?: (op: PhoneOp, args: Record<string, unknown>) => unknown): PhoneLinkHandle & { reqs: Array<{ op: string }> } {
  const reqs: Array<{ op: string }> = [];
  return {
    deviceId: id,
    control: state,
    reqs,
    request: (op, args) => {
      reqs.push({ op });
      return Promise.resolve(onReq?.(op, args) ?? {});
    },
    openTunnel: () => ({ send: () => {}, ack: () => {}, close: () => {} }),
  };
}

describe('phone-adb', () => {
  it('lists likely adb locations, SDK first', () => {
    const list = adbCandidates('/Users/x');
    expect(list[0]).toBe('/Users/x/Library/Android/sdk/platform-tools/adb');
    expect(list).toContain('/opt/homebrew/bin/adb');
  });

  it('parses `adb devices -l`, telling USB from Wi-Fi', () => {
    const out = 'List of devices attached\nR5CX12 device usb:1-1 product:x\n192.168.1.5:5555 device\n';
    const list = parseDevices(out);
    expect(list).toEqual([
      { serial: 'R5CX12', state: 'device', usb: true },
      { serial: '192.168.1.5:5555', state: 'device', usb: false },
    ]);
  });
});

describe('PhoneControl routes', () => {
  const id = 'aa';
  const device: DeviceRecord = { cert: cert(id), pairedAt: 1, use: 'use' };

  it('uses USB when a phone is plugged in', async () => {
    const { sys } = fakeSys([{ match: /devices -l/, out: 'List\nR5CX12 device usb:1-1\n' }]);
    const link = fakeLink(id.padEnd(16, '0'), control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id.padEnd(16, '0'));
    expect(r?.route).toBe('usb');
    expect(r?.adb?.serial).toBe('R5CX12');
  });

  it('connects over Wi-Fi when debugging is on and an IP is known', async () => {
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\n' },
      { match: /connect 192\.168\.1\.9:40000/, out: 'connected to 192.168.1.9:40000' },
    ]);
    const link = fakeLink(id.padEnd(16, '0'), control({ adb: { on: true, port: 40000 }, wifi: { ip: '192.168.1.9' } }));
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id.padEnd(16, '0'));
    expect(r?.route).toBe('wifi');
    expect(calls.some((c) => /connect 192\.168\.1\.9:40000/.test(c))).toBe(true);
  });

  it('falls back to the Accessibility service when there is no adb', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id.padEnd(16, '0'), control());
    // No adbPath override: discovery runs and finds nothing.
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    const r = await ctl.reach(id.padEnd(16, '0'));
    expect(r?.route).toBe('accessibility');
  });

  it('is off (no reach) until the phone is turned on', async () => {
    const { sys } = fakeSys([]);
    const off: DeviceRecord = { cert: cert(id), pairedAt: 1, use: 'off' };
    const link = fakeLink(id.padEnd(16, '0'), control());
    const ctl = new PhoneControl({ sys, devices: book([off]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    await expect(ctl.screenshot(id.padEnd(16, '0'))).rejects.toThrow(/off for Claude/);
  });
});

describe('PhoneControl operations', () => {
  const id = 'bb'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('bb'), pairedAt: 1, use: 'use' };

  it('taps over adb with input tap', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\nR5 device usb:1\n' }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.tap(id, { x: 100, y: 200 });
    expect(calls.some((c) => /shell input tap 100 200/.test(c))).toBe(true);
  });

  it('taps a screen node over the Accessibility service when there is no adb', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    await ctl.tap(id, { x: 0, y: 0, node: 3 });
    expect(link.reqs).toEqual([{ op: 'tap' }]);
  });

  it('refuses a shell command when only the Accessibility service is there', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    await expect(ctl.shell(id, 'ls')).rejects.toThrow(/Wireless debugging/);
  });

  it('screenshots over adb as PNG bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { sys } = fakeSys([
      { match: /devices -l/, out: 'List\nR5 device usb:1\n' },
      { match: /exec-out screencap/, bytes: png },
    ]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const shot = await ctl.screenshot(id);
    expect(shot.mime).toBe('image/png');
    expect(shot.image.equals(png)).toBe(true);
  });
});

describe('screen descriptions', () => {
  it('turns an Accessibility tree into tappable lines', () => {
    const view: ScreenView = {
      gen: 1,
      app: 'com.app',
      w: 1080,
      h: 2400,
      nodes: [
        { i: 0, d: 0, c: 'Button', t: 'Send', b: [0, 0, 100, 50], f: 'c' },
        { i: 1, d: 1, c: 'EditText', h: 'Message', b: [0, 60, 500, 110], f: 'e' },
      ],
    };
    const text = describeScreen(view);
    expect(text).toContain('#0 Button "Send" (tap) @50,25');
    expect(text).toContain('#1 EditText "Message" (type) @250,85');
  });

  it('turns uiautomator XML into the same kind of lines', () => {
    const xml = '<hierarchy><node text="OK" resource-id="com.app:id/ok" class="android.widget.Button" clickable="true" bounds="[10,20][110,70]"/></hierarchy>';
    const text = describeUiautomator(xml);
    expect(text).toContain('#0 Button "OK" [ok] (tap) @60,45');
  });
});
