import { fromPhone } from '../core/client-context.js';
import { needSentinel } from '../core/sentinel/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `sentinel.*` method does (see sentinel-api.ts): you act as yourself. */

type SentinelMethod = Extract<Method, `sentinel.${string}`>;
type SentinelHandlers = { readonly [M in SentinelMethod]: (s: Session, ...args: Args<M>) => unknown };

const later = (what: string): never => {
  throw new Error(`${what} isn’t available yet: it comes with the next part of Sentinel`);
};

export const SENTINEL_HANDLERS = {
  'sentinel.create': (s, draft) => needSentinel(s).create(draft),
  'sentinel.update': (s, id, patch) => needSentinel(s).update(id, patch),
  'sentinel.remove': (s, id) => needSentinel(s).remove(id),
  'sentinel.duplicate': (s, id) => needSentinel(s).duplicate(id),
  // Run Now from the phone says so in the run's history ("You ran it from your phone").
  'sentinel.run': (s, id) => needSentinel(s).start(id, fromPhone() ? 'phone' : 'you'),
  'sentinel.stop': (s, runId) => needSentinel(s).stop(runId),
  'sentinel.pause': (s, id, paused) => needSentinel(s).pause(id, paused),
  'sentinel.runs': (s, id) => needSentinel(s).runsOf(id),
  'sentinel.runGet': (s, runId) => needSentinel(s).runGet(runId),
  'sentinel.draft': (s) => {
    needSentinel(s);
    return later('Describing a sentinel for Claude to write');
  },
  'sentinel.recipes': (s) => needSentinel(s).recipes(),
  'sentinel.decide': (s, runId, choice) => needSentinel(s).decide(runId, choice),
  'sentinel.setRunAtOnce': (s, n) => needSentinel(s).setRunAtOnce(n),
  'sentinel.rotateSecret': (s) => {
    needSentinel(s);
    return later('A webhook sentinel’s secret');
  },
  'sentinel.webhookUrl': (s) => {
    needSentinel(s);
    return later('A webhook sentinel’s URL');
  },
} satisfies SentinelHandlers;
