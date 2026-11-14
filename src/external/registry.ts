import type { SemanticStatus } from './adapters/semantic-search.js';
import type { ExternalService } from './service.js';

/** Which external agents' server serves a session (the daemon's), so the API can reach it. */
const services = new WeakMap<object, ExternalService>();

export const attachExternal = (session: object, service: ExternalService): void => void services.set(session, service);
export const detachExternal = (session: object): void => void services.delete(session);

/** Semantic tool search's status, for its pane in Settings (adapters/semantic-search.ts). */
const toolSearches = new WeakMap<object, () => SemanticStatus>();
export const attachToolSearch = (session: object, status: () => SemanticStatus): void => void toolSearches.set(session, status);
export const toolSearchStatus = (session: object): SemanticStatus => toolSearches.get(session)?.() ?? { state: 'idle' };

/** The session's server, or a clear error where there is none (tests, a core with no daemon). */
export function needExternal(session: object): ExternalService {
  const service = services.get(session);
  if (!service) throw new Error('External agents need the Beluga app (its daemon).');
  return service;
}
