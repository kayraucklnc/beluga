import { needSentinel } from '../core/sentinel/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `dashboard.*` method does (see dashboard-api.ts): you act as yourself. */

type DashboardMethod = Extract<Method, `dashboard.${string}`>;
type DashboardHandlers = { readonly [M in DashboardMethod]: (s: Session, ...args: Args<M>) => unknown };

export const DASHBOARD_HANDLERS = {
  'dashboard.create': (s, name) => needSentinel(s).dashboards.create(name),
  'dashboard.update': (s, id, patch) => needSentinel(s).dashboards.update(id, patch),
  'dashboard.remove': (s, id) => needSentinel(s).dashboards.remove(id),
  'dashboard.addTile': (s, id, tile, at) => needSentinel(s).dashboards.addTile(id, tile, at),
  'dashboard.updateTile': (s, id, tileId, patch) => needSentinel(s).dashboards.updateTile(id, tileId, patch),
  'dashboard.removeTile': (s, id, tileId) => needSentinel(s).dashboards.removeTile(id, tileId),
  'dashboard.moveTile': (s, id, tileId, index) => needSentinel(s).dashboards.moveTile(id, tileId, index),
  'dashboard.refresh': (s, id) => needSentinel(s).refresh(id),
  'dashboard.ask': (s, id, text) => needSentinel(s).dashboardAsk(id, text),
} satisfies DashboardHandlers;
