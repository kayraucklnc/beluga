import { needGateway } from '../core/gateway/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `gateway.*` method does (see gateway-api.ts). */

type GatewayMethod = Extract<Method, `gateway.${string}`>;
type GatewayHandlers = { readonly [M in GatewayMethod]: (s: Session, ...args: Args<M>) => unknown };

export const GATEWAY_HANDLERS = {
  'gateway.list': (s) => {
    const state = s.store.getState().gateway;
    return { tasks: state.tasks, cards: state.cards, note: state.note };
  },
  'gateway.confirm': (s, id, yes, edited) => needGateway(s).confirm(id, yes, edited),
  'gateway.cancel': (s, id) => needGateway(s).cancel(id),
  'gateway.ask': (s, person, ask, opts) => needGateway(s).ask({ person, ask, by: 'person', ...(opts?.needs ? { needs: opts.needs } : {}), ...(opts?.project ? { project: opts.project } : {}) }),
  'gateway.setNote': (s, note) => needGateway(s).setNote(note),
} satisfies GatewayHandlers;
