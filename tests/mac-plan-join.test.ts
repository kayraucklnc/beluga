import { describe, expect, it } from 'vitest';
import type { MilestoneView } from '../src/core/plans/progress.js';
import { lockWords, milestoneJoin, milestoneLink, settingUp, startingMilestones } from '../packages/mac/src/plans/plans-model.js';

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

describe('right after approving', () => {
  const task = (state: string, over: object = {}) => ({ task: { id: state, title: state }, state, forYou: false, waitsOn: [], ...over });
  const open = (title: string, tasks: object[], over: object = {}) => ({ milestone: { id: title, title }, state: 'running', autonomy: 'gated', run: {}, tasks, ...over });
  const view = (open: object[], plan: object = {}) => ({ plan: { status: 'active', paused: false, ...plan }, open }) as unknown as Parameters<typeof startingMilestones>[0];

  it('a milestone whose Claude is being started says so, until something of it is at work', () => {
    const a = open('API', [task('ready'), task('blocked')]);
    expect(startingMilestones(view([a])).map((m) => m.milestone.title)).toEqual(['API']);
    // Already a Claude of its own, a task under way, only your tasks, Step by Step, paused: not starting.
    expect(startingMilestones(view([open('API', [task('ready')], { run: { agent: { worktree: 'w' } } })]))).toEqual([]);
    expect(startingMilestones(view([open('API', [task('ready'), task('running', { worktree: 'w' })])]))).toEqual([]);
    expect(startingMilestones(view([open('API', [task('ready', { forYou: true })])]))).toEqual([]);
    expect(startingMilestones(view([open('API', [task('ready')], { autonomy: 'step' })]))).toEqual([]);
    expect(startingMilestones(view([a], { paused: true }))).toEqual([]);
  });

  it('says what it sets up: the branch first when there is none yet', () => {
    const ms = [open('API', []), open('UI', []), open('Docs', [])] as unknown as Parameters<typeof settingUp>[1];
    expect(settingUp({ plan: {} } as Parameters<typeof settingUp>[0], ms.slice(0, 1))).toBe('Setting up: making the plan’s branch, then starting a Claude for “API”');
    expect(settingUp({ plan: { branch: 'plan/x' } } as Parameters<typeof settingUp>[0], ms)).toBe('Setting up: starting a Claude for “API”, “UI” and “Docs”');
  });
});
