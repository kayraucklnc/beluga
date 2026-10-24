import { merge, mergeCheck, resolve } from '../companion/merge.js';
import { macViewFor } from '../companion/open-on-mac.js';
import { stripCode } from '../companion/strip.js';
import { needBoard } from '../core/board/registry.js';
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
  'companion.openOnMac': async (s, target) => {
    const view = macViewFor(s.store.getState(), target);
    if (!view) return { opened: false, why: 'That isn’t on your Mac any more' };
    // A worktree's conversation is loaded before it's shown (as opening it on the Mac does).
    if (view.kind === 'workspace') s.workspaces?.ensureLoaded(view.id);
    const raised = await s.showOnScreens({ type: 'navigate', view });
    return raised ? { opened: true } : { opened: false, why: 'Beluga isn’t open on your Mac' };
  },
  'companion.icon': (s, sum) => needCompanion(s).icon(sum),
  'companion.mergeCheck': (s, topic) => mergeCheck(s, topic),
  'companion.merge': (s, topic) => merge(s, needCompanion(s).merges, topic),
  'companion.resolve': (s, topic) => resolve(s, needCompanion(s).merges, topic),
  'companion.draftTask': async (s, a) => {
    const d = await needBoard(s).draft(a.projectId, a.text);
    // Words only: a code block in the goal (rare in a draft) reads "(code)" on the phone.
    return { title: d.title, goal: stripCode(d.goal).text.replace(/\[\[code(?::\d+)?\]\]/g, '(code)'), acceptance: [...d.acceptance], labels: [...d.labels], ...(d.priority ? { priority: d.priority } : {}) };
  },
  'companion.addTask': (s, a) => {
    const issue = needBoard(s).addDraft(a.projectId, { title: a.title, goal: a.goal, acceptance: a.acceptance, labels: a.labels, ...(a.priority ? { priority: a.priority } : {}) });
    return { id: issue.id, key: issue.key };
  },
} satisfies CompanionHandlers;
