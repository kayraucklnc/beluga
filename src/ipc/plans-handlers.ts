import { needPlans } from '../core/plans/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `plans.*` method does (see plans-api.ts): you act as yourself. */

type PlansMethod = Extract<Method, `plans.${string}`>;
type PlansHandlers = { readonly [M in PlansMethod]: (s: Session, ...args: Args<M>) => unknown };

export const PLANS_HANDLERS = {
  'plans.create': (s, input) => needPlans(s).create(input),
  'plans.here': (s, channel, autonomy) => needPlans(s).here(channel, autonomy),
  'plans.approve': (s, id) => needPlans(s).approve(id),
  'plans.discard': (s, id) => needPlans(s).discard(id) ?? null,
  'plans.edit': (s, id, ops) => needPlans(s).edit(id, ops),
  'plans.setAutonomy': (s, id, autonomy, milestone) => needPlans(s).setAutonomy(id, autonomy, milestone),
  'plans.setPaused': (s, id, paused) => needPlans(s).setPaused(id, paused),
  'plans.setParallel': (s, id, n) => needPlans(s).setParallel(id, n),
  'plans.setTestsAt': (s, id, when) => needPlans(s).setTestsAt(id, when),
  'plans.tidyUp': (s, id, yes) => needPlans(s).tidyUp(id, yes),
  'plans.pass': (s, id, milestone) => needPlans(s).pass(id, milestone),
  'plans.recheck': (s, id, milestone) => needPlans(s).recheck(id, milestone),
  'plans.sendBack': (s, id, milestone, note) => needPlans(s).sendBack(id, milestone, note),
  'plans.openPr': (s, id) => needPlans(s).openPr(id),
  'plans.mergePr': (s, id) => needPlans(s).mergePr(id),
  'plans.mergeLocal': (s, id) => needPlans(s).mergeLocal(id),
  'plans.startTask': (s, id, task) => needPlans(s).startTask(id, task),
  'plans.resumeTask': (s, id, task) => needPlans(s).resumeTask(id, task),
  'plans.remove': (s, id) => needPlans(s).remove(id),
  'plans.setStyle': (s, text) => needPlans(s).setStyle(text),
} satisfies PlansHandlers;
