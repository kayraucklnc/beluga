import type { MacAssistant } from './assistant.js';

/** Which "Your Mac" serves a session (the daemon's), so the API and Claude's runs can reach it. */
const all = new WeakMap<object, MacAssistant>();

export const attachAssistant = (session: object, assistant: MacAssistant): void => void all.set(session, assistant);
export const detachAssistant = (session: object): void => void all.delete(session);
export const assistantOf = (session: object): MacAssistant | undefined => all.get(session);
