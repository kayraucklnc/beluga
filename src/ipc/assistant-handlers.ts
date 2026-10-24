import { assistantOf } from '../core/assistant/registry.js';
import type { MacAssistant } from '../core/assistant/assistant.js';
import { busyChannels } from '../core/board/work.js';
import type { Session } from '../core/session.js';
import { assistantChannel } from '../shared/assistant.js';
import type { Args, Method } from './api.js';

/** What each `assistant.*` method does (see assistant-api.ts). */

type AssistantMethod = Extract<Method, `assistant.${string}`>;
type AssistantHandlers = { readonly [M in AssistantMethod]: (s: Session, ...args: Args<M>) => unknown };

const mac = (s: Session): MacAssistant => {
  const a = assistantOf(s);
  if (!a) throw new Error('Your Mac’s assistant needs the Beluga app');
  return a;
};

export const ASSISTANT_HANDLERS = {
  'assistant.newChat': (s) => mac(s).newChat(),
  'assistant.openChat': (s, id) => mac(s).openChat(id),
  'assistant.deleteChat': async (s, id) => {
    const a = mac(s);
    const channel = assistantChannel(id);
    // Its Claude stops first: nothing it says after lands anywhere.
    if (busyChannels(s.store.getState().log).has(channel)) s.host.stopRun(channel);
    s.host.forgetContext(channel);
    await a.deleteChat(id);
  },
} satisfies AssistantHandlers;
