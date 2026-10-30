import { needDialogues } from '../core/dialogues/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `dialogues.*` method does (see dialogues-api.ts): you act as yourself. */

type DialoguesMethod = Extract<Method, `dialogues.${string}`>;
type DialoguesHandlers = { readonly [M in DialoguesMethod]: (s: Session, ...args: Args<M>) => unknown };

export const DIALOGUES_HANDLERS = {
  'dialogues.start': (s, input) =>
    needDialogues(s).start({
      channel: input.channel,
      participants: input.agents.map((agent) => ({ agent })),
      topic: input.topic,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.turnCap ? { turnCap: input.turnCap } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.confirmed ? { confirmed: true } : {}),
    }),
  'dialogues.confirm': (s, id, caps) => needDialogues(s).confirm(id, caps ? { ...(caps.turnCap ? { turnCap: caps.turnCap } : {}), ...(caps.budget !== undefined ? { budget: caps.budget } : {}) } : undefined),
  'dialogues.continue': (s, id, more) => needDialogues(s).continue(id, more),
  'dialogues.stop': (s, id) => needDialogues(s).stop(id),
  'dialogues.interject': (s, id, text) => needDialogues(s).interject(id, text),
} satisfies DialoguesHandlers;
