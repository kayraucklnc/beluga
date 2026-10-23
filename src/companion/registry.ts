import type { CompanionHost } from './host.js';

/** Which companion host serves a session (the daemon's), so the API can reach it. */
const hosts = new WeakMap<object, CompanionHost>();

export const attachCompanion = (session: object, host: CompanionHost): void => void hosts.set(session, host);
export const detachCompanion = (session: object): void => void hosts.delete(session);
export const companionOf = (session: object): CompanionHost | undefined => hosts.get(session);

/** The session's companion host, or a clear error where there is none (tests, the terminal on its own). */
export function needCompanion(session: object): CompanionHost {
  const host = hosts.get(session);
  if (!host) throw new Error('Pairing a phone needs the Beluga app (its daemon).');
  return host;
}
