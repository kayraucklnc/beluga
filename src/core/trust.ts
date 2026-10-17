import type { TrustLevel } from './settings.js';
import type { AppState } from './store.js';

export type { TrustLevel } from './settings.js';

/** Plain-language names and what each level means, used everywhere it's shown. */
export const TRUST_INFO: Readonly<Record<TrustLevel, { label: string; short: string; detail: string }>> = {
  blocked: { label: "Can't use my Claude", short: 'blocked', detail: 'They can chat, but requests for your Claude are declined.' },
  ask: { label: 'Ask me each time', short: 'asks you', detail: 'You approve each request. Their Claude only reaches your shared folders; reading anything else asks you.' },
  trusted: { label: 'Trusted', short: 'trusted', detail: 'Requests run without asking. Commands, edits and files outside your shared folders still ask you.' },
  full: { label: 'Full trust', short: 'full trust', detail: 'Anything on this computer, without asking, like you would yourself. Secrets (.env, keys) stay blocked.' },
};

/** The level someone gets when you haven't picked one: your default for new people. */
export function defaultTrust(state: Pick<AppState, 'policy'>): TrustLevel {
  return state.policy === 'deny' ? 'blocked' : state.policy === 'auto' ? 'trusted' : 'ask';
}

/** How much you trust this person right now (you always fully trust yourself). */
export function trustOf(state: Pick<AppState, 'policy' | 'levels' | 'self'>, peerId: string): TrustLevel {
  if (peerId === state.self?.peerId) return 'full';
  return state.levels[peerId] ?? defaultTrust(state);
}

/** How far a request from this person may reach: 'full' lets their Claude read anywhere without asking. */
export function reachOf(state: Pick<AppState, 'policy' | 'levels' | 'self' | 'access'>, peerId: string): 'folder' | 'full' {
  return trustOf(state, peerId) === 'full' ? 'full' : (state.access[peerId] ?? 'folder');
}
