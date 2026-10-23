import type { Gateway } from './gateway.js';

/** Which gateway serves a session (the daemon's), so the room and the API can reach it. */
const gateways = new WeakMap<object, Gateway>();

export const attachGateway = (session: object, gateway: Gateway): void => void gateways.set(session, gateway);
export const detachGateway = (session: object): void => void gateways.delete(session);
export const gatewayOf = (session: object): Gateway | undefined => gateways.get(session);

/** The session's gateway, or a clear error where there is none (the terminal on its own). */
export function needGateway(session: object): Gateway {
  const gw = gateways.get(session);
  if (!gw) throw new Error('Tasks between Claudes need the Beluga app (its daemon): they are not available here.');
  return gw;
}
