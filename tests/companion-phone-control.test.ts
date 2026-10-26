import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ExecBytesResult, ExecResult, SystemPort } from '../src/core/gateway/device.js';
import { adbCandidates, parseDevices, parseMdns, parseWmSize } from '../src/companion/phone-adb.js';
import { AnnexBSplitter, videoSize } from '../src/companion/phone-video.js';
import { type MirrorStatus, PhoneControl, type PhoneLinkHandle, type PhoneTouch, type VideoPiece, describeScreen, describeUiautomator, parseNotifications, phoneErrorText } from '../src/companion/phone-control.js';
import { DeviceBook, type DeviceRecord } from '../src/companion/devices.js';
import { type DeviceCert, MacFrame, PhoneFrame, type PhoneControl as PhoneControlState, type PhoneOp, type ScreenView } from '../src/companion/protocol.js';
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

describe('mirror and action (BLG-171)', () => {
  const id = 'cc'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('cc'), pairedAt: 1, use: 'use' };
  // A 1×1 PNG (valid IHDR: 1×1), so pngSize reads 1×1.
  const onePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA', 'base64');

  it('action() taps over adb when the Accessibility service is off', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\nR5 device usb:1\n' }]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.action(id, 'tap', { x: 5, y: 9 });
    expect(calls.some((c) => /shell input tap 5 9/.test(c))).toBe(true);
  });

  it('runEnv puts adb on PATH for the owner’s Bash', () => {
    const { sys } = fakeSys([]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/opt/sdk/platform-tools/adb' });
    const env = ctl.runEnv();
    expect(env.PATH?.startsWith('/opt/sdk/platform-tools')).toBe(true);
  });

  it('startMirror streams frames over adb and stops cleanly', async () => {
    const { sys } = fakeSys([
      { match: /devices -l/, out: 'List\nR5 device usb:1\n' },
      { match: /exec-out screencap/, bytes: onePng },
    ]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/fake/adb' });
    const frames: Array<{ mime: string }> = [];
    let route: string | undefined;
    const stop = ctl.startMirror(id, { fps: 30 }, (f) => frames.push(f), (srv) => { if (srv.route) route = srv.route; });
    await new Promise((r) => setTimeout(r, 120));
    stop();
    const got = frames.length;
    expect(got).toBeGreaterThan(0);
    expect(frames[0]!.mime).toBe('image/png');
    expect(route).toBe('usb');
    // After stop, no more frames arrive.
    await new Promise((r) => setTimeout(r, 80));
    expect(frames.length).toBe(got);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a smooth mirror (BLG-184)', () => {
  const id = 'ee'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('ee'), pairedAt: 1, use: 'use' };
  const shot = { b64: 'AAAA', mime: 'image/jpeg', w: 1080, h: 2400 };

  it('waits out Android’s screenshot gap instead of showing an error, and finds the route once', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\n' }]);
    let n = 0;
    const link = fakeLink(id, control(), (op) => {
      if (op !== 'screenshot') return {};
      // Every other one comes too soon after the last (Android's 333 ms rule): code 3.
      if (++n % 2 === 0) throw new Error("Call to function 'PhoneControl.perform' has been rejected.\n\u00e2\u0086\u0092 Caused by: java.lang.IllegalStateException: The screenshot failed (code 3); the screen may be protected");
      return shot;
    });
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const frames: unknown[] = [];
    const statuses: MirrorStatus[] = [];
    const stop = ctl.startMirror(id, { fps: 30 }, (f) => frames.push(f), (st) => statuses.push(st));
    await sleep(1300);
    stop();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(statuses.filter((st) => st.error)).toEqual([]);
    expect(statuses[0]).toMatchObject({ on: true, route: 'accessibility' });
    expect(calls.filter((c) => /devices -l/.test(c))).toHaveLength(1);
    // An app without video is never asked for it.
    expect(link.reqs.some((r) => r.op === 'mirror')).toBe(false);
  });

  it('plays live video once the phone streams, and shows pictures again when it stops', async () => {
    const { sys } = fakeSys([{ match: /devices -l/, out: 'List\n' }]);
    let piece: ((p: VideoPiece) => void) | undefined;
    let end: ((reason?: string) => void) | undefined;
    const asked: Array<Record<string, unknown>> = [];
    const base = fakeLink(id, control({ video: true }), (op, args) => {
      if (op === 'mirror') {
        asked.push(args);
        return { state: args.on ? 'asking' : 'off' };
      }
      return op === 'screenshot' ? shot : {};
    });
    const link: PhoneLinkHandle = {
      ...base,
      video: true,
      watchVideo: (onPiece, onEnd) => {
        piece = onPiece;
        end = onEnd;
        return () => (piece = undefined);
      },
    };
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const frames: unknown[] = [];
    const pieces: VideoPiece[] = [];
    const statuses: MirrorStatus[] = [];
    const stop = ctl.startMirror(id, { fps: 30, video: true }, (f) => frames.push(f), (st) => statuses.push(st), (p) => pieces.push(p));
    await sleep(60);
    expect(asked[0]).toMatchObject({ on: true, max: 1280, fps: 30 });
    expect(statuses.some((st) => st.video === 'asking')).toBe(true);
    expect(frames.length).toBeGreaterThan(0); // pictures while the phone asks "Start now"

    // "Start now": pieces flow (a still screen still sends a few a second), and pictures stop.
    const flow = setInterval(() => piece?.({ seq: pieces.length, b64: 'AAAB', key: pieces.length === 0, ts: 0, w: 592, h: 1280, sw: 1440, sh: 3120 }), 50);
    await sleep(500);
    const shown = frames.length;
    await sleep(700);
    expect(pieces.length).toBeGreaterThan(10);
    expect(statuses.at(-1)).toMatchObject({ on: true, video: 'on' });
    expect(frames.length).toBe(shown);

    // The phone stops it (said no, or pressed Stop): pictures again, with a word why.
    clearInterval(flow);
    end?.('Not allowed on the phone');
    await sleep(700);
    expect(frames.length).toBeGreaterThan(shown);
    expect(statuses.at(-1)?.video).toBeUndefined();
    expect(statuses.some((st) => st.note === 'Not allowed on the phone')).toBe(true);
    stop();
    await sleep(10);
    expect(asked.at(-1)).toEqual({ on: false });
  });

  it('keeps only the cause’s own words from the app’s native errors', () => {
    expect(phoneErrorText("Call to function 'PhoneControl.perform' has been rejected.\n\u00e2\u0086\u0092 Caused by: java.lang.IllegalStateException: No text field has the focus")).toBe('No text field has the focus');
    expect(phoneErrorText("Call to function 'PhoneControl.perform' has been rejected.\n→ Caused by: java.util.concurrent.ExecutionException: java.lang.IllegalStateException: The screenshot failed (code 3); x")).toBe('The screenshot failed (code 3); x');
    expect(phoneErrorText('sh.ratel.beluga.control.BelugaAccessibilityService$TooSoon: The screenshot failed (code 3): asked too soon')).toBe('The screenshot failed (code 3): asked too soon');
    expect(phoneErrorText('Turn on Accessibility for Beluga on the phone')).toBe('Turn on Accessibility for Beluga on the phone');
  });

  it('has the video frames in the protocol', () => {
    expect(PhoneFrame.safeParse({ t: 'vid', seq: 3, b64: 'AAAB', key: true, ts: 1000, w: 592, h: 1280, sw: 1440, sh: 3120 }).success).toBe(true);
    expect(PhoneFrame.safeParse({ t: 'vid_end', reason: 'Not allowed on the phone' }).success).toBe(true);
    expect(MacFrame.safeParse({ t: 'vid_ack', seq: 3 }).success).toBe(true);
    expect(MacFrame.safeParse({ t: 'req', id: 1, op: 'mirror', args: { on: true } }).success).toBe(true);
  });
});

// ---- BLG-185/186/187: video over adb, quick taps, Claude's touches, Wi-Fi debugging found by name

/** Annex B units: a start code (4-byte for parameter sets, 3-byte for pictures, as encoders write them) and the unit. */
const unit = (bytes: number[], long = false): number[] => [...(long ? [0, 0, 0, 1] : [0, 0, 1]), ...bytes];
const SPS_U = [0x67, 0x42, 0xc0, 0x1f, 0xda];
const PPS_U = [0x68, 0xce, 0x3c, 0x80];
// A key picture and a following one (first_mb_in_slice 0: the byte after the header has its top bit set).
const IDR_U = [0x65, 0x88, 0x84, 0x21, 0x10];
const P_U = [0x41, 0x9a, 0x22, 0x33];

/** A SystemPort whose `stream` plays `chunks` (a phone's screenrecord), then stays open until stop(). */
function streamingSys(script: Array<{ match: RegExp; out?: string; code?: number; bytes?: Buffer }>, chunks: Buffer[]): { sys: SystemPort; calls: string[]; stopped: () => boolean } {
  const base = fakeSys(script);
  let stopped = false;
  const sys: SystemPort = {
    ...base.sys,
    stream: (_cmd, args, onData) => {
      base.calls.push(args.join(' '));
      let i = 0;
      const tick = setInterval(() => {
        if (stopped || i >= chunks.length) return clearInterval(tick);
        onData(chunks[i++]!);
      }, 30);
      return { stop: () => void (stopped = true) };
    },
  };
  return { sys, calls: base.calls, stopped: () => stopped };
}

describe('the mirror over adb plays video (BLG-185)', () => {
  it('cuts a screenrecord stream into pictures, the SPS/PPS ahead of each key frame, whatever the chunks', async () => {
    const pieces: Array<{ bytes: number[]; key: boolean }> = [];
    const split = new AnnexBSplitter((bytes, key) => pieces.push({ bytes: [...bytes], key }), 20);
    const stream = Buffer.from([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U), ...unit(P_U), ...unit(P_U)]);
    // In awkward pieces, as adb hands them over.
    for (const at of [3, 9, 17, 22]) split.push(stream.subarray([0, 3, 9, 17, 22].at([3, 9, 17, 22].indexOf(at))!, at));
    split.push(stream.subarray(22));
    await new Promise((r) => setTimeout(r, 60));
    expect(pieces.map((p) => p.key)).toEqual([true, false, false]);
    expect(pieces[0]!.bytes).toEqual([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U)]);
    // The last picture isn't held back until the screen changes again: a pause lets it go.
    expect(pieces[2]!.bytes).toEqual(unit(P_U));
    split.close();
  });

  it('after a picture cut short, waits for the next key frame', async () => {
    const pieces: boolean[] = [];
    const split = new AnnexBSplitter((_b, key) => pieces.push(key), 10);
    split.push(Buffer.from([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U)]));
    await new Promise((r) => setTimeout(r, 30));
    // The rest of that picture came late (no start code): broken until a key frame.
    split.push(Buffer.from([0x11, 0x22, ...unit(P_U), ...unit(P_U)]));
    await new Promise((r) => setTimeout(r, 30));
    split.push(Buffer.from([...unit(IDR_U), ...unit(P_U)]));
    await new Promise((r) => setTimeout(r, 30));
    expect(pieces).toEqual([true, true, false]);
    split.close();
  });

  it('reads the screen’s size, the video’s size, and the phone on the network', () => {
    expect(parseWmSize('Physical size: 1440x3120\n')).toEqual({ w: 1440, h: 3120 });
    expect(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n')).toEqual({ w: 1080, h: 2340 });
    expect(videoSize({ w: 1440, h: 3120 }, 1280)).toEqual({ w: 592, h: 1280 });
    expect(parseMdns('List of discovered mdns services\nadb-R5CX72-Ab1Cd2\t_adb-tls-connect._tcp\t172.17.12.32:37481\nadb-R5CX72-Ab1Cd2\t_adb-tls-pairing._tcp.\t172.17.12.32:41231\n')).toEqual([
      { name: 'adb-R5CX72-Ab1Cd2', service: '_adb-tls-connect._tcp', addr: '172.17.12.32:37481' },
      { name: 'adb-R5CX72-Ab1Cd2', service: '_adb-tls-pairing._tcp', addr: '172.17.12.32:41231' },
    ]);
    // adb's own name for a phone it reached over Wi-Fi isn't a USB one.
    expect(parseDevices('List\nadb-R5CX72-Ab1Cd2._adb-tls-connect._tcp device product:x\n')[0]?.usb).toBe(false);
  });

  const id = 'ff'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('ff'), pairedAt: 1, use: 'use' };
  const onePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA', 'base64');

  it('streams screenrecord over USB instead of a picture each time, and stops it with the mirror', async () => {
    const chunks = [Buffer.from([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U)]), Buffer.from(unit(P_U)), Buffer.from(unit(P_U))];
    const { sys, calls, stopped } = streamingSys(
      [
        { match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' },
        { match: /wm size/, out: 'Physical size: 1440x3120\n' },
        { match: /exec-out screencap/, bytes: onePng },
      ],
      chunks,
    );
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/fake/adb' });
    const pieces: VideoPiece[] = [];
    const statuses: MirrorStatus[] = [];
    const stop = ctl.startMirror(id, { fps: 30, video: true }, () => {}, (st) => statuses.push(st), (p) => pieces.push(p));
    await sleep(400);
    const record = calls.find((c) => /screenrecord/.test(c));
    expect(record).toContain('--output-format=h264 --size 592x1280 --bit-rate 6000000');
    expect(pieces.map((p) => p.key)).toEqual([true, false, false]);
    expect(pieces[0]).toMatchObject({ w: 592, h: 1280, sw: 1440, sh: 3120 });
    expect(statuses.at(-1)).toMatchObject({ on: true, route: 'usb', video: 'on' });
    // A still screen sends nothing over adb, and that's fine: no pictures while the stream runs.
    const shots = calls.filter((c) => /screencap/.test(c)).length;
    await sleep(400);
    expect(calls.filter((c) => /screencap/.test(c)).length).toBe(shots);
    // The phone was remembered by its USB serial, to find its Wi-Fi debugging later.
    expect(book([device]).get(id)).toBeDefined();
    stop();
    expect(stopped()).toBe(true);
  });

  it('the mirror’s own taps go by the Accessibility service when it’s on, and the route is reused', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.action(id, 'tap', { x: 5, y: 9 });
    await ctl.action(id, 'swipe', { x1: 1, y1: 2, x2: 3, y2: 4 });
    expect(link.reqs.map((r) => r.op)).toEqual(['tap', 'swipe']);
    expect(calls.some((c) => /input tap/.test(c))).toBe(false);
    expect(calls.filter((c) => /devices -l/.test(c))).toHaveLength(1);
  });

  it('shows the mirrors what Claude does, and counts the phone busy a while', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id, control());
    let changes = 0;
    const devices = book([device]);
    const ctl = new PhoneControl({ sys, devices, link: () => link, onChange: () => void changes++, home: '/nope' });
    const seen: PhoneTouch[] = [];
    const off = ctl.onTouch(id, (t) => seen.push(t));
    const kit = ctl.toolsFor()!;
    expect(ctl.controlView(id).busy).toBeUndefined();
    await kit.tools.tap({ x: 100, y: 200 });
    await kit.tools.swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });
    await kit.tools.type({ text: 'secret' });
    await kit.tools.key('back');
    expect(seen).toEqual([{ op: 'tap', x: 100, y: 200 }, { op: 'swipe', x: 1, y: 2, x2: 3, y2: 4 }, { op: 'type' }, { op: 'key', what: 'back' }]);
    expect(JSON.stringify(seen)).not.toContain('secret');
    expect(ctl.controlView(id).busy).toBe(true);
    expect(changes).toBeGreaterThan(0);
    off();
  });
});

describe('Wireless debugging found by name (BLG-187)', () => {
  const id = 'ab'.padEnd(16, '0');

  it('connects over the same Wi‑Fi to where this Mac hears the phone, by the USB serial it once had', async () => {
    const device: DeviceRecord = { cert: cert('ab'), pairedAt: 1, use: 'use', adbSerial: 'R5CX72' };
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\n' },
      { match: /mdns services/, out: 'List of discovered mdns services\nadb-R5CX72-Ab1Cd2\t_adb-tls-connect._tcp\t172.17.12.32:37481\n' },
      { match: /connect 172\.17\.12\.32:37481/, out: 'connected to 172.17.12.32:37481' },
    ]);
    // An app that doesn't say its debugging port (or hasn't found it yet).
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id);
    expect(r?.route).toBe('wifi');
    expect(r?.adb?.serial).toBe('172.17.12.32:37481');
    expect(calls.some((c) => /connect 172\.17\.12\.32:37481/.test(c))).toBe(true);
  });

  it('Use over Wi‑Fi turns on Wireless debugging over the cable and connects', async () => {
    const device: DeviceRecord = { cert: cert('ab'), pairedAt: 1, use: 'use' };
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' },
      { match: /mdns services/, out: 'adb-R5CX72-Ab1Cd2\t_adb-tls-connect._tcp\t172.17.12.32:37481\n' },
      { match: /connect 172\.17\.12\.32:37481/, out: 'connected to 172.17.12.32:37481' },
    ]);
    const devices = book([device]);
    const ctl = new PhoneControl({ sys, devices, link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/fake/adb' });
    const said = await ctl.overWifi(id);
    expect(said).toContain('172.17.12.32:37481');
    expect(calls.some((c) => /shell settings put global adb_wifi_enabled 1/.test(c))).toBe(true);
    expect(devices.get(id)?.adbSerial).toBe('R5CX72');
    expect(ctl.controlView(id).adb).toBe('connected');
  });
});

describe('macros (BLG-175)', () => {
  const id = 'dd'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('dd'), pairedAt: 1, use: 'use' };
  const screen = { gen: 1, app: 'com.x', w: 1080, h: 2400, nodes: [{ i: 0, d: 0, c: 'Button', t: 'Send', b: [100, 200, 300, 260], f: 'c' }] };

  it('runs a flow, finding tapText by on-screen text (Accessibility route)', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]); // no adb → Accessibility
    const link = fakeLink(id, control(), (op) => (op === 'screen' ? screen : {}));
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    const log = await ctl.runMacro(id, [{ op: 'open', package: 'com.x' }, { op: 'tapText', text: 'Send' }]);
    const ops = link.reqs.map((r) => r.op);
    expect(ops).toContain('open');
    expect(ops).toContain('screen');
    expect(ops).toContain('tap');
    expect(log).toContain('tapped “Send”');
  });
});

describe('notifications (BLG-176)', () => {
  it('parses dumpsys notification records', () => {
    const dump = [
      'NotificationRecord(0x1 pkg=com.whatsapp user=0',
      '      android.title=String (Mum)',
      '      android.text=String (Call me when you land)',
      'NotificationRecord(0x2 pkg=com.google.android.gm user=0',
      '      android.title=String (3 new emails)',
      '      android.text=String (Receipts and more)',
    ].join('\n');
    const list = parseNotifications(dump);
    expect(list).toEqual([
      { app: 'com.whatsapp', title: 'Mum', text: 'Call me when you land' },
      { app: 'com.google.android.gm', title: '3 new emails', text: 'Receipts and more' },
    ]);
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
