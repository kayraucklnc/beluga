import type { Session } from '../core/session.js';
import { fetchSource } from '../core/views/sources.js';
import type { Source } from '../shared/view-spec.js';
import type { Args, Method } from './api.js';

/** What each `view.*` method does (see views-api.ts). */

type ViewsMethod = Extract<Method, `view.${string}`>;
type ViewsHandlers = { readonly [M in ViewsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const VIEWS_HANDLERS = {
  'view.fetch': (_s, source, query, opts) => fetchSource(source as Source, query, opts ?? {}),
} satisfies ViewsHandlers;
