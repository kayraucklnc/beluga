import { describe, expect, it } from 'vitest';
import { modeOf, switchesOf } from '../packages/mac/src/lib/update-model.js';
import { type Run } from '../src/update/check.js';
import { type Found, type Saved, LAUNCH_AFTER_MS, LOOK_EVERY_MS, RETRY_AFTER_MS, UpdateWatch, baseVersion, isNewer, lookDue, lookOnline, quietNow, watchesItself } from '../src/update/auto.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

describe('when the terminal app looks for a new version', () => {
  it('looks at launch unless it just looked, and every four hours while it runs', () => {
    expect(LAUNCH_AFTER_MS).toBe(HOUR);
    expect(LOOK_EVERY_MS).toBe(4 * HOUR);
    expect(lookDue(NOW, undefined, undefined, 'launch')).toBe(true);
    expect(lookDue(NOW, NOW - 30 * 60_000, undefined, 'launch')).toBe(false);
    expect(lookDue(NOW, NOW - HOUR, undefined, 'launch')).toBe(true);
    expect(lookDue(NOW, NOW - 3 * HOUR, undefined, 'running')).toBe(false);
    expect(lookDue(NOW, NOW - 4 * HOUR, undefined, 'running')).toBe(true);
  });

  it('waits an hour after a failed look, and a clock that went backwards doesn’t stop it', () => {
    expect(lookDue(NOW, NOW - 30 * HOUR, NOW - 10 * 60_000, 'running')).toBe(false);
    expect(lookDue(NOW, NOW - 30 * HOUR, NOW - RETRY_AFTER_MS, 'running')).toBe(true);
    expect(lookDue(NOW, NOW + HOUR, undefined, 'running')).toBe(true);
    expect(lookDue(NOW, undefined, NOW + HOUR, 'running')).toBe(true);
  });
});

describe('which version is newer', () => {
  it('compares Beluga’s own version, not the Mac app’s build on it', () => {
    expect(baseVersion('0.4.0+mac.0.5.1')).toBe('0.4.0');
    expect(baseVersion('v1.2.3\n')).toBe('1.2.3');
    expect(isNewer('0.5.0', '0.4.9')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.4.0', '0.4.0+mac.0.5.1')).toBe(false);
    expect(isNewer('0.4.1', '0.4.0+mac.0.5.1')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0-beta.2')).toBe(true);
    expect(isNewer('1.0.0-beta.2', '1.0.0')).toBe(false);
    expect(isNewer('0.4.0', '0.5.0')).toBe(false);
  });

  it('never takes something that isn’t a version as newer', () => {
    expect(isNewer('', '0.4.0')).toBe(false);
    expect(isNewer('npm ERR! 404', '0.4.0')).toBe(false);
    expect(isNewer('9.9.9', 'unknown')).toBe(false);
  });

  it('leaves the Mac app’s daemon to the Mac app’s updater, and can be turned off', () => {
    expect(watchesItself('0.4.0', {})).toBe(true);
    expect(watchesItself('0.4.0+mac.0.5.1', {})).toBe(false);
    expect(watchesItself('0.4.0', { check: '0' })).toBe(false);
  });
});

describe('looking online', () => {
  const fake = (o: { git?: boolean; global?: boolean; latest?: string; behind?: number }): Run => async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key.includes('--show-toplevel')) {
      if (!o.git) throw new Error('not a repo');
      return `${process.cwd()}\n`;
    }
    if (key === 'npm root -g') return o.global ? `${process.cwd()}/..\n` : '/somewhere/else\n';
    if (key.startsWith('npm view')) return `${o.latest ?? '0.0.0'}\n`;
    if (key.includes('@{u}')) return 'origin/main\n';
    if (key.includes('--abbrev-ref HEAD')) return 'main\n';
    if (key.includes('rev-list')) return `${o.behind ?? 0}\t0\n`;
    return '';
  };

  it('finds new commits for a git checkout (and never installs them by itself)', async () => {
    expect(await lookOnline(fake({ git: true, behind: 3 }), process.cwd())).toEqual({ kind: 'git', count: 3 });
    expect(await lookOnline(fake({ git: true, behind: 0 }), process.cwd())).toBeUndefined();
  });

  it('leaves a Beluga inside someone’s project alone', async () => {
    expect(await lookOnline(fake({ global: false, latest: '99.0.0' }), process.cwd())).toBeUndefined();
  });
});

/** An UpdateWatch with everything it does recorded. */
function watch(o: { current?: string; found?: Found | 'offline'; auto?: boolean; idle?: boolean; restart?: boolean; installs?: boolean; saved?: Saved; now?: number }) {
  const said: string[] = [];
  const installed: string[] = [];
  const restarted: string[] = [];
  let looks = 0;
  let saved: Saved = o.saved ?? {};
  let now = o.now ?? NOW;
  let auto = o.auto ?? false;
  let idle = o.idle ?? true;
  const w = new UpdateWatch({
    current: o.current ?? '0.4.0',
    look: async () => {
      looks++;
      if (o.found === 'offline') throw new Error('offline');
      return o.found;
    },
    install: async (v) => {
      installed.push(v);
      return o.installs ?? true;
    },
    auto: () => auto,
    idle: () => idle,
    ...(o.restart === false ? {} : { restart: (v: string) => void restarted.push(v) }),
    tell: (text) => void said.push(text),
    load: () => saved,
    save: (s) => void (saved = s),
    now: () => now,
  });
  return {
    w,
    said,
    installed,
    restarted,
    looks: () => looks,
    saved: () => saved,
    later: (ms: number) => void (now += ms),
    setAuto: (v: boolean) => void (auto = v),
    setIdle: (v: boolean) => void (idle = v),
  };
}

describe('what the watch does with what it finds', () => {
  it('with Update automatically off: says once that a version is available, installs nothing', async () => {
    const t = watch({ found: { kind: 'npm', version: '0.5.0' } });
    await t.w.tick('launch');
    t.later(4 * HOUR);
    await t.w.tick('running');
    expect(t.looks()).toBe(2);
    expect(t.said).toEqual(['Beluga 0.5.0 is available (you have 0.4.0). Run beluga update, or turn on Update automatically in Settings']);
    expect(t.installed).toEqual([]);
    expect(t.saved()).toEqual({ lastCheck: NOW + 4 * HOUR, latest: '0.5.0' });
  });

  it('with it on: installs in the background, then restarts once nothing is running', async () => {
    const t = watch({ found: { kind: 'npm', version: '0.5.0' }, auto: true, idle: false });
    await t.w.tick('launch');
    expect(t.installed).toEqual(['0.5.0']);
    expect(t.said).toEqual(['Beluga 0.5.0 is installed. It restarts into it once nothing is running']);
    expect(t.restarted).toEqual([]);
    expect(t.w.waiting).toBe('0.5.0');
    // Claude is still working: no restart, and no more looking either.
    await t.w.tick('running');
    expect(t.restarted).toEqual([]);
    t.setIdle(true);
    await t.w.tick('running');
    expect(t.restarted).toEqual(['0.5.0']);
    expect(t.looks()).toBe(1);
  });

  it('in a terminal (no restart of its own): asks you to start it again', async () => {
    const t = watch({ found: { kind: 'npm', version: '0.5.0' }, auto: true, restart: false });
    await t.w.tick('launch');
    expect(t.said).toEqual(['Beluga 0.5.0 is installed. Quit and start Beluga again to use it']);
  });

  it('an install that fails says how to do it by hand, once, and isn’t retried behind your back', async () => {
    const t = watch({ found: { kind: 'npm', version: '0.5.0' }, auto: true, installs: false });
    await t.w.tick('launch');
    t.later(4 * HOUR);
    await t.w.tick('running');
    expect(t.installed).toEqual(['0.5.0']);
    expect(t.said).toEqual(["Beluga 0.5.0 didn't install by itself. Run beluga update to install it", 'Beluga 0.5.0 is available (you have 0.4.0). Run beluga update, or turn on Update automatically in Settings']);
  });

  it('up to date: says nothing; offline: says nothing and tries again an hour later', async () => {
    const current = watch({ found: undefined });
    await current.w.tick('launch');
    expect(current.said).toEqual([]);
    expect(current.saved()).toEqual({ lastCheck: NOW });

    const offline = watch({ found: 'offline' });
    await offline.w.tick('launch');
    offline.later(30 * 60_000);
    await offline.w.tick('running');
    expect(offline.looks()).toBe(1);
    offline.later(30 * 60_000);
    await offline.w.tick('running');
    expect(offline.looks()).toBe(2);
    expect(offline.said).toEqual([]);
  });

  it('a launch right after another window looked uses what it found, without asking npm again', async () => {
    const off = watch({ saved: { lastCheck: NOW - 10 * 60_000, latest: '0.5.0' } });
    await off.w.tick('launch');
    expect(off.looks()).toBe(0);
    expect(off.said).toHaveLength(1);

    const on = watch({ saved: { lastCheck: NOW - 10 * 60_000, latest: '0.5.0' }, auto: true });
    await on.w.tick('launch');
    expect(on.installed).toEqual(['0.5.0']);

    // Already on that version (installed by the other window): nothing to say.
    const same = watch({ current: '0.5.0', saved: { lastCheck: NOW - 10 * 60_000, latest: '0.5.0' } });
    await same.w.tick('launch');
    expect(same.said).toEqual([]);
  });

  it('a git checkout is told about new commits once', async () => {
    const t = watch({ found: { kind: 'git', count: 2 }, auto: true });
    await t.w.tick('launch');
    t.later(4 * HOUR);
    await t.w.tick('running');
    expect(t.said).toEqual(['Beluga has 2 new changes on GitHub. Run beluga update to get them']);
    expect(t.installed).toEqual([]);
  });
});

describe('what counts as nothing running', () => {
  const self = { peerId: 'me', name: 'kay', shares: [], agent: true };
  it('no Claude working and nobody else in the room', () => {
    expect(quietNow({ log: [], peers: [self], self })).toBe(true);
    expect(quietNow({ log: [], peers: [self, { ...self, peerId: 'bob', name: 'bob' }], self })).toBe(false);
    const running = { type: 'agent', status: 'tool' } as never;
    expect(quietNow({ log: [running], peers: [self], self })).toBe(false);
  });
});

describe('the Mac app’s two switches', () => {
  it('Update automatically and Check for updates, as the mode the app shell keeps', () => {
    expect(switchesOf('idle')).toEqual({ auto: true, check: true });
    expect(switchesOf('ask')).toEqual({ auto: false, check: true });
    expect(switchesOf('off')).toEqual({ auto: false, check: false });
    expect(modeOf({ auto: true }, 'ask')).toBe('idle');
    expect(modeOf({ auto: false }, 'idle')).toBe('ask');
    // Updating automatically needs looking; not looking turns it off.
    expect(modeOf({ auto: true }, 'off')).toBe('idle');
    expect(modeOf({ check: false }, 'idle')).toBe('off');
    expect(modeOf({ check: true }, 'off')).toBe('ask');
  });
});
