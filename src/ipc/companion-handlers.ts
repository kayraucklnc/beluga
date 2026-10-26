import { branchStep } from '../companion/branch-steps.js';
import { goneTopics } from '../companion/gone.js';
import { merge, mergeCheck, resolve } from '../companion/merge.js';
import { macViewFor } from '../companion/open-on-mac.js';
import { stripCode } from '../companion/strip.js';
import { subAgentDetail } from '../companion/sub-agent.js';
import { claudeCodeOf } from '../core/claude-code/launch.js';
import { type ViewFetchArgs, viewFetch } from '../companion/view-fetch.js';
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
  'companion.phone.use': (s, id, use) => needCompanion(s).setPhoneUse(id, use),
  'companion.phone.pairAdb': (s, id) => needCompanion(s).pairPhoneAdb(id),
  'companion.phone.wifi': (s, id) => needCompanion(s).phoneOverWifi(id),
  'companion.phone.act': (s, id, op, args) => needCompanion(s).phoneAction(id, op, args),
  'companion.phone.macros': (s) => needCompanion(s).listPhoneMacros(),
  'companion.phone.macroRun': (s, name) => needCompanion(s).runPhoneMacro(name),
  'companion.phone.macroDelete': (s, name) => needCompanion(s).deletePhoneMacro(name),
  'companion.older': (s, topic, page) => needCompanion(s).older(topic, page.before, page.limit),
  'companion.ask': (s, a) => needCompanion(s).ask(callerOf(), a),
  'companion.post': (s, a) => needCompanion(s).post(callerOf(), a),
  'companion.askPerson': (s, a) => needCompanion(s).askPerson(callerOf(), a),
  'companion.signOut': (s) => needCompanion(s).signOut(callerOf()),
  'companion.keepAwake': (s, mode) => s.setPrefs({ keepAwake: mode }),
  'companion.openOnMac': async (s, target) => {
    const view = macViewFor(s.store.getState(), target);
    if (!view) return { opened: false, why: 'That isn’t on your Mac any more' };
    // A worktree's conversation is loaded before it's shown (as opening it on the Mac does).
    if (view.kind === 'workspace') s.workspaces?.ensureLoaded(view.id);
    const raised = await s.showOnScreens({ type: 'navigate', view });
    return raised ? { opened: true } : { opened: false, why: 'Beluga isn’t open on your Mac' };
  },
  'companion.icon': (s, sum) => needCompanion(s).icon(sum),
  'companion.voice': (s) => needCompanion(s).voice.status(),
  'companion.voicePrepare': (s, model) => needCompanion(s).voice.prepare(model),
  'companion.transcribe': (s, a) => needCompanion(s).transcribe(callerOf(), a),
  'companion.mergeCheck': (s, topic) => mergeCheck(s, topic),
  'companion.merge': (s, topic) => merge(s, needCompanion(s).merges, topic),
  'companion.resolve': (s, topic) => resolve(s, needCompanion(s).merges, topic),
  'companion.branchStep': (s, topic, step) => branchStep(s, topic, step),
  'companion.viewFetch': (s, a) => viewFetch(s.store.getState(), a as ViewFetchArgs),
  'companion.draftTask': async (s, a) => {
    const d = await needBoard(s).draft(a.projectId, a.text);
    // Words only: a code block in the goal (rare in a draft) reads "(code)" on the phone.
    return { title: d.title, goal: stripCode(d.goal).text.replace(/\[\[code(?::\d+)?\]\]/g, '(code)'), acceptance: [...d.acceptance], labels: [...d.labels], ...(d.priority ? { priority: d.priority } : {}) };
  },
  'companion.addTask': (s, a) => {
    const issue = needBoard(s).addDraft(a.projectId, { title: a.title, goal: a.goal, acceptance: a.acceptance, labels: a.labels, ...(a.priority ? { priority: a.priority } : {}) });
    return { id: issue.id, key: issue.key };
  },
  'companion.files.list': (s, topic, rel) => needCompanion(s).filesList(topic, rel),
  'companion.files.find': (s, topic, query) => needCompanion(s).filesFind(topic, query),
  'companion.files.read': (s, topic, rel, opts) => needCompanion(s).filesRead(topic, rel, opts?.off ?? 0),
  'companion.terminals': (s, topic) => needCompanion(s).terminalsOf(topic),
  'companion.termOpen': (s, topic, opts) => needCompanion(s).termOpen(callerOf(), topic, opts ?? {}),
  'companion.termClose': (s, key) => needCompanion(s).termClose(callerOf(), key),
  'companion.subAgent': (s, topic, turn, id) =>
    subAgentDetail(s.store.getState(), {
      steps: (channel, itemId) => s.host.stepsFor(channel, itemId),
      step: (channel, itemId, stepId) => s.host.stepFor(channel, itemId, stepId),
      ccSteps: (sessionId, agentId) => claudeCodeOf(s).steps(sessionId, agentId, { limit: 200 }),
    }, topic, turn, id),
  'companion.gone': (s, topics) => ({ gone: goneTopics(s.store.getState(), topics) }),
} satisfies CompanionHandlers;
