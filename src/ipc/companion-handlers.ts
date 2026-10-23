import { needCompanion } from '../companion/registry.js';
import { currentClient } from '../core/client-context.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `companion.*` method does (see companion-api.ts). Results carry no keys or secrets beyond the pairing's own link and code. */

/** Who is calling (a phone's calls run as `phone:<device id>`). */
const callerOf = (): string => currentClient() ?? '';

type CompanionMethod = Extract<Method, `companion.${string}`>;
type CompanionHandlers = { readonly [M in CompanionMethod]: (s: Session, ...args: Args<M>) => unknown };

export const COMPANION_HANDLERS = {
  'companion.pair.start': (s) => needCompanion(s).pairStart(),
  'companion.pair.approve': (s) => needCompanion(s).pairApprove(),
  'companion.pair.cancel': (s) => needCompanion(s).pairCancel(),
  'companion.devices.remove': (s, id) => needCompanion(s).removeDevice(id),
  'companion.older': (s, topic, page) => needCompanion(s).older(topic, page.before, page.limit),
  'companion.ask': (s, a) => needCompanion(s).ask(callerOf(), a),
  'companion.post': (s, a) => needCompanion(s).post(callerOf(), a),
  'companion.askPerson': (s, a) => needCompanion(s).askPerson(callerOf(), a),
  'companion.signOut': (s) => needCompanion(s).signOut(callerOf()),
} satisfies CompanionHandlers;
