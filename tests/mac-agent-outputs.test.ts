import { describe, expect, it } from 'vitest';
import { howLabel, outputsKey, placeOf } from '../packages/mac/src/claude-code/outputs-model.js';

/** A sub-agent's Outputs: where each file is, said briefly, and how it came to be. */
describe('sub-agent outputs model', () => {
  const where = { scratch: '/w/app/.klaud/scratch/agents/0123456789', cwd: '/w/app', home: '/Users/kay' };

  it('says where a file is from the nearest place you know', () => {
    expect(placeOf('/w/app/.klaud/scratch/agents/0123456789/shots/a.png', where)).toEqual({ name: 'a.png', dir: 'shots' });
    expect(placeOf('/w/app/.klaud/scratch/agents/0123456789/a.png', where)).toEqual({ name: 'a.png', dir: '' });
    expect(placeOf('/w/app/test-results/login/trace.png', where)).toEqual({ name: 'trace.png', dir: 'test-results/login' });
    expect(placeOf('/Users/kay/Desktop/s.png', where)).toEqual({ name: 's.png', dir: '~/Desktop' });
    expect(placeOf('/tmp/pw/s.png', where)).toEqual({ name: 's.png', dir: '/tmp/pw' });
    expect(placeOf('/private/var/folders/ab/xy/T/run/out.log', where)).toEqual({ name: 'out.log', dir: 'tmp/run' });
    expect(placeOf('/var/folders/ab/xy/T/out.log', where)).toEqual({ name: 'out.log', dir: 'tmp' });
    expect(placeOf('/a.png', {})).toEqual({ name: 'a.png', dir: '/' });
  });

  it('says how it came to be', () => {
    expect(howLabel('wrote')).toBe('Saved');
    expect(howLabel('ran')).toBe('From a command');
    expect(howLabel('read')).toBe('Looked at');
  });

  it('changes key only when a file does', () => {
    const a = [{ path: '/a', mtime: 1, size: 2 }];
    expect(outputsKey(a)).toBe(outputsKey([{ ...a[0]! }]));
    expect(outputsKey(a)).not.toBe(outputsKey([{ ...a[0]!, mtime: 3 }]));
  });
});
