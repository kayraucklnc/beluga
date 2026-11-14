import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/core/board/model.js';
import { isPlanHome, planForHome, plansOfHome } from '../src/core/plans/model.js';
import { isLivePlan } from '../src/core/plans/owner.js';
import { Plans } from '../src/core/plans/plans.js';
import { Store, initialState } from '../src/core/store.js';

/** A closed plan keeps its record, and a chat lists all of its plans (BLG-414). */

const me: Actor = { kind: 'person', id: 'p-me', name: 'Kay' } as Actor;

function setup(opts: { dir?: string } = {}) {
  let at = 1000;
  const store = new Store(initialState('room'));
  const plans = new Plans({ store, dir: opts.dir ?? null, now: () => (at += 10) });
  return { store, plans, state: () => store.getState().plans };
}

describe('closing a plan', () => {
  it('sets closedAt and closedBy and keeps the plan', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    const closed = t.plans.close(plan.id, me);
    expect(closed.closedAt).toBeGreaterThan(plan.createdAt);
    expect(closed.closedBy).toEqual(me);
    expect(closed.status).toBe('draft');
    expect(t.plans.get(plan.id)).toEqual(closed);
    expect(closed.activity.at(-1)).toMatchObject({ kind: 'closed' });
  });

  it('pauses an active plan', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    t.plans.approved(plan.id, { title: 'x', goal: '', milestones: [{ id: 'm', title: 'M', criteria: [], tasks: [{ id: 't', title: 'T', acceptance: [], blockedBy: [] }] }] } as never, me, '1 task');
    expect(t.plans.need(plan.id).status).toBe('active');
    const closed = t.plans.close(plan.id, me);
    expect(closed).toMatchObject({ status: 'active', paused: true });
  });

  it('refuses a plan that is already closed, or not here', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    t.plans.close(plan.id, me);
    expect(() => t.plans.close(plan.id, me)).toThrow(/already closed/);
    expect(() => t.plans.close('pl_nope', me)).toThrow(/isn’t here/);
  });

  it('is read-only: no draft, no resume', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    t.plans.close(plan.id, me);
    expect(() => t.plans.writeDraft(plan.id, { title: 'x', milestones: [] } as never, me)).toThrow(/closed/);
    expect(() => t.plans.setPaused(plan.id, false, me)).toThrow(/closed/);
  });
});

describe('a chat’s plans', () => {
  it('planForHome and isPlanHome skip closed plans', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    expect(planForHome(t.state(), 'ws:main')?.id).toBe(plan.id);
    expect(isPlanHome(t.state(), 'ws:main')).toBe(true);
    t.plans.close(plan.id, me);
    expect(planForHome(t.state(), 'ws:main')).toBeUndefined();
    expect(isPlanHome(t.state(), 'ws:main')).toBe(false);
  });

  it('a closed plan is not live: its chat no longer folds into it', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    expect(isLivePlan(t.plans.need(plan.id))).toBe(true);
    expect(isLivePlan(t.plans.close(plan.id, me))).toBe(false);
  });

  it('plansOfHome lists every plan of the chat, newest first', () => {
    const t = setup();
    const a = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    t.plans.close(a.id, me);
    t.plans.create({ projectId: 'api', home: 'ws:other' }, me);
    const b = t.plans.create({ projectId: 'api', home: 'ws:main' }, me);
    expect(plansOfHome(t.state(), 'ws:main').map((p) => p.id)).toEqual([b.id, a.id]);
    expect(planForHome(t.state(), 'ws:main')?.id).toBe(b.id);
    expect(plansOfHome(t.state(), 'ws:none')).toEqual([]);
  });
});

describe('plans.json', () => {
  it('an old file (no closedAt) loads unchanged; a closed plan loads closed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plans-close-'));
    const old = { id: 'pl_old', projectId: 'api', home: 'ws:main', status: 'draft', draftRev: 1, autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', paused: false, runs: {}, activity: [], createdAt: 1, updatedAt: 1 };
    const closed = { ...old, id: 'pl_closed', home: 'ws:b', closedAt: 5, closedBy: me };
    writeFileSync(path.join(dir, 'plans.json'), JSON.stringify({ version: 1, plans: [old, closed] }));
    const t = setup({ dir });
    expect(t.plans.need('pl_old')).toEqual(old);
    expect(t.plans.need('pl_closed')).toMatchObject({ closedAt: 5, closedBy: me });
    expect(planForHome(t.state(), 'ws:main')?.id).toBe('pl_old');
    expect(planForHome(t.state(), 'ws:b')).toBeUndefined();
  });
});
