import { describe, expect, it } from 'vitest';
import type { MilestoneView } from '../src/core/plans/progress.js';
import { lockWords, milestoneJoin, milestoneLink } from '../packages/mac/src/plans/plans-model.js';

/** A milestone that waits on several: their lines meet in one join, and each says how its merge stands (BLG-482). */

const ms = (title: string, state: MilestoneView['state'], over: Partial<MilestoneView> = {}): MilestoneView =>
  ({ milestone: { id: title, title, criteria: [], tasks: [] }, state, run: {}, tasks: [], dependsOn: [], ...over }) as unknown as MilestoneView;

describe('a milestone’s line into what waits on it', () => {
  it('says Merging (and a conflict being fixed, or one left to you) while its work goes into the plan’s branch', () => {
    expect(milestoneLink(ms('A', 'running'))).toEqual({ state: 'waiting', label: 'Unlocks' });
    expect(milestoneLink(ms('A', 'gate'))).toEqual({ state: 'ready', label: 'Unlocks' });
    expect(milestoneLink(ms('A', 'merging'))).toEqual({ state: 'ready', label: 'Merging' });
    const conflict = { at: 1, dir: '/tmp/x', merging: 'b', files: ['a.ts'] };
    expect(milestoneLink(ms('A', 'merging', { merging: { at: 1, by: { kind: 'beluga' }, conflict } }))).toEqual({ state: 'ready', label: 'Fixing a conflict' });
    expect(milestoneLink(ms('A', 'merging', { merging: { at: 1, by: { kind: 'beluga' }, conflict: { ...conflict, stuck: true } } })).label).toBe('Conflict: needs you');
    expect(milestoneLink(ms('A', 'passed'))).toEqual({ state: 'done', label: 'Unlocked' });
  });
});

describe('the join', () => {
  it('only where several lead in, counting those merged in, naming what it still waits on', () => {
    expect(milestoneJoin([ms('A', 'passed')], 'plan/x')).toBeUndefined();
    const j = milestoneJoin([ms('A', 'passed'), ms('B', 'merging'), ms('C', 'running')], 'plan/x')!;
    expect(j).toMatchObject({ passed: 1, total: 3, state: 'ready' });
    expect(j.tip).toBe('Unlocks when all 3 have passed and merged into plan/x · waiting on “B”, “C”');
    expect(milestoneJoin([ms('A', 'passed'), ms('B', 'passed')], 'plan/x')).toMatchObject({ passed: 2, total: 2, state: 'done', tip: 'All 2 passed and merged into plan/x: it starts from plan/x' });
  });

  it('the lock says what it waits on, then the branch it starts from', () => {
    expect(lockWords(['A', 'B'], 2, 'plan/x')).toBe('Unlocks when “A” and “B” pass and are merged into plan/x');
    expect(lockWords(['A'], 1, undefined)).toBe('Unlocks when “A” passes');
    expect(lockWords([], 2, 'plan/x')).toBe('Unlocked: starts from plan/x, with all 2 before it merged in');
    expect(lockWords([], 1, undefined)).toBe('Unlocked');
  });
});
