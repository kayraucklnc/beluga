import { describe, expect, it } from 'vitest';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { planView } from '../src/core/plans/progress.js';
import { NO_BOARD } from '../src/core/board/model.js';
import { changeMarks, changeWords, gateId, graphShape, groupId, nextWords, planStatus, plansOf, taskNodeId } from '../packages/mac/src/plans/plans-model.js';
import { columnAt, edgeSpeed, isDrag, landingIndex, leanFor, neighbours, withGap } from '../packages/mac/src/tasks/board-drag.js';
import { nextMode } from '../packages/mac/src/chat/compose-mode.js';

/** The Plans screens' pure parts, the board's drag, and the composer's modes. */

const body = normalizeBody({
  title: 'P',
  goal: 'g',
  milestones: [
    { id: 'one', title: 'One', criteria: ['works'], tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', blockedBy: ['a'] }, { id: 'c', title: 'C' }] },
    { id: 'two', title: 'Two', tasks: [{ id: 'd', title: 'D', blockedBy: ['b'] }, { id: 'e', title: 'E', blockedBy: ['d'] }] },
  ],
});
const plan = (over: Partial<Plan> = {}): Plan => ({ id: 'p', projectId: 'x', home: 'ws:h', status: 'draft', draft: body, draftRev: 1, autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', paused: false, runs: {}, activity: [], createdAt: 0, updatedAt: 0, ...over });

describe('the plan graph’s shape', () => {
  it('lines: blockers, the last tasks to the gate, the gate to the next milestone', () => {
    const shape = graphShape(plan());
    const ids = shape.edges.map((e) => `${e.kind}:${e.from}>${e.to}`);
    expect(ids).toContain(`blocks:${taskNodeId('a')}>${taskNodeId('b')}`);
    expect(ids).toContain(`finish:${taskNodeId('b')}>${gateId('one')}`);
    expect(ids).toContain(`finish:${taskNodeId('c')}>${gateId('one')}`);
    expect(ids).not.toContain(`finish:${taskNodeId('a')}>${gateId('one')}`);
    expect(ids).toContain(`next:${gateId('one')}>${groupId('two')}`);
    // Across milestones: drawn as a blocker (shown when picked).
    expect(ids).toContain(`blocks:${taskNodeId('b')}>${taskNodeId('d')}`);
  });

  it('its key changes with the shape only (status moving on never re-lays it out)', () => {
    const a = graphShape(plan());
    expect(graphShape(plan({ draft: { ...body, title: 'Renamed' } })).key).toBe(a.key);
    expect(graphShape(plan({ draft: normalizeBody({ ...body, milestones: [...body.milestones, { title: 'Three', tasks: [] }] }) })).key).not.toBe(a.key);
  });
});

describe('words for a plan', () => {
  it('a draft waits for approval', () => {
    const v = planView(plan(), NO_BOARD);
    expect(planStatus(v)).toEqual({ label: 'Draft', tone: 'muted' });
    expect(nextWords(v.next).title).toBe('Approve Plan');
  });

  it('proposed changes are marked per task and counted', () => {
    const approved = normalizeBody(body);
    const next = normalizeBody({ ...body, milestones: [{ ...body.milestones[0]!, tasks: [...body.milestones[0]!.tasks, { id: 'f', title: 'F', acceptance: [], blockedBy: [] }] }, body.milestones[1]!] });
    const p = plan({ status: 'active', body: approved, draft: next });
    expect([...changeMarks(p)]).toEqual([['f', 'added']]);
    expect(changeWords(p)).toBe('1 new');
    expect(planStatus(planView(p, NO_BOARD)).label).toBe('Changes proposed');
  });

  it('a project’s plans: running, then drafts, then done', () => {
    const list = plansOf({ enabled: true, style: '', plans: [plan({ id: 'd', status: 'done', updatedAt: 9 }), plan({ id: 'r', status: 'draft', updatedAt: 5 }), plan({ id: 'a', status: 'active', updatedAt: 1 }), plan({ id: 'o', projectId: 'other' })] }, 'x');
    expect(list.map((p) => p.id)).toEqual(['a', 'r', 'd']);
  });
});

describe('the board’s drag', () => {
  const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0 });
  it('lands above the first card whose middle is below the pointer', () => {
    const cards = [box(0, 60), box(70, 130), box(140, 200)];
    expect(landingIndex(10, cards)).toBe(0);
    expect(landingIndex(40, cards)).toBe(1);
    expect(landingIndex(500, cards)).toBe(3);
    expect(landingIndex(5, [])).toBe(0);
  });

  it('the column under the pointer, or the nearest', () => {
    const cols = [
      { key: 'todo', box: { top: 0, bottom: 1, left: 0, right: 100 } },
      { key: 'done', box: { top: 0, bottom: 1, left: 120, right: 220 } },
    ];
    expect(columnAt(50, cols)).toBe('todo');
    expect(columnAt(110, cols)).toBe('todo');
    expect(columnAt(400, cols)).toBe('done');
  });

  it('a gap where it would land, the lifted card out; its neighbours there', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(withGap(items, 'a', 1)).toEqual([{ id: 'b' }, 'gap', { id: 'c' }]);
    expect(neighbours(items, 'a', 1)).toEqual({ before: 'b', after: 'c' });
    expect(neighbours(items, 'c', 0)).toEqual({ after: 'a' });
  });

  it('leans a little with speed; scrolls near edges; tells a drag from a click', () => {
    expect(leanFor(0)).toBe(0);
    expect(leanFor(10_000)).toBe(6);
    expect(leanFor(-10_000)).toBe(-6);
    expect(edgeSpeed(500, 0, 1000)).toBe(0);
    expect(edgeSpeed(5, 0, 1000)).toBeLessThan(0);
    expect(edgeSpeed(995, 0, 1000)).toBeGreaterThan(0);
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(4, 3)).toBe(true);
  });
});

describe('the composer’s modes', () => {
  it('⇧⇥ switches acting and planning first (Plan with Tasks is never a keystroke away)', () => {
    expect(nextMode('act')).toBe('plan');
    expect(nextMode('plan')).toBe('act');
    expect(nextMode('tasks')).toBe('act');
  });
});
