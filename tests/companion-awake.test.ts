import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Awake } from '../src/companion/awake.js';

/** A caffeinate that's only a record of how it was started and whether it was stopped. */
function fakeSpawn() {
  const runs: Array<{ args: readonly string[]; killed: boolean }> = [];
  const spawn = (_cmd: string, args: readonly string[]) => {
    const run = { args, killed: false };
    runs.push(run);
    const child = Object.assign(new EventEmitter(), {
      kill: () => {
        run.killed = true;
        child.emit('exit', null);
        return true;
      },
    });
    return child as never;
  };
  return { runs, spawn };
}

describe('keeping the Mac awake for the phone (BLG-127)', () => {
  it('holds caffeinate only while a phone is paired and it is asked for', () => {
    const f = fakeSpawn();
    const a = new Awake({ spawn: f.spawn, platform: 'darwin' });
    a.set('always', false);
    a.set('off', true);
    expect(f.runs).toHaveLength(0);
    a.set('power', true);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]!.args).toEqual(['-s', '-w', String(process.pid)]);
    // The same again changes nothing.
    a.set('power', true);
    expect(f.runs).toHaveLength(1);
    a.set('always', true);
    expect(f.runs[0]!.killed).toBe(true);
    expect(f.runs[1]!.args[0]).toBe('-i');
    expect(a.mode).toBe('always');
    // The last phone removed: the Mac may sleep again.
    a.set('always', false);
    expect(f.runs[1]!.killed).toBe(true);
    expect(a.mode).toBe('off');
  });

  it('does nothing off a Mac', () => {
    const f = fakeSpawn();
    new Awake({ spawn: f.spawn, platform: 'linux' }).set('always', true);
    expect(f.runs).toHaveLength(0);
  });
});
