import { z } from 'zod';
import { API, type Method } from '../ipc/api.js';
import { ChatMessageView, MergeCheckView, MergeView, TurnView } from './protocol.js';

/**
 * Every call the phone may make, typed: each `phone` method of coverage.ts with its arguments
 * (the very zod tuple the daemon checks, from src/ipc/api.ts) and what comes back. The app
 * imports this instead of keeping its own list; tests/companion-coverage.test.ts checks the keys
 * are exactly the `phone` methods. Results the phone only shows as done-or-failed are `unknown`.
 * Browser-safe: zod and the API list only (as the Mac app's web view loads them).
 */

const entry = <M extends Method, R extends z.ZodType>(method: M, result: R) => ({ args: API[method].args as (typeof API)[M]['args'], result });
const done = z.unknown();

export const AskResult = z.object({ topic: z.string() });
export const AskPersonResult = z.object({ topic: z.string(), task: z.string() });
export const OlderResult = z.union([z.object({ turns: z.array(TurnView), more: z.boolean() }), z.object({ messages: z.array(ChatMessageView), more: z.boolean() })]);
/** Open on your Mac: it came to the front, or why not. */
export const OpenOnMacResult = z.object({ opened: z.boolean(), why: z.string().optional() });
/** A project's small icon (PNG, or a small SVG), by checksum. */
export const IconResult = z.object({ sum: z.string(), mime: z.string(), b64: z.string() });
/** Your Claude's draft of a task described in words (companion.draftTask), before it's added. */
export const TaskDraftResult = z.object({ title: z.string(), goal: z.string(), acceptance: z.array(z.string()), labels: z.array(z.string()), priority: z.enum(['urgent', 'high', 'medium', 'low']).optional() });
export type TaskDraftResult = z.infer<typeof TaskDraftResult>;
/** What `put` answers: a piece taken, then the file's ref. */
export const PutResult = z.union([z.object({ received: z.number().int().min(0) }), z.object({ ref: z.string() })]);

export const PhoneCalls = {
  'session.submit': entry('session.submit', done),
  'host.answerApproval': entry('host.answerApproval', done),
  'host.promote': entry('host.promote', done),
  'host.sendNext': entry('host.sendNext', done),
  'host.stopRun': entry('host.stopRun', z.object({ stopped: z.boolean(), returned: z.array(z.string()) }).partial().passthrough().optional()),
  'host.cancelQueued': entry('host.cancelQueued', done),
  'inbox.read': entry('inbox.read', done),
  'inbox.unread': entry('inbox.unread', done),
  'questions.answer': entry('questions.answer', done),
  'questions.pick': entry('questions.pick', done),
  'invites.letIn': entry('invites.letIn', done),
  'invites.decline': entry('invites.decline', done),
  'workspaces.load': entry('workspaces.load', done),
  'workspaces.startChat': entry('workspaces.startChat', done),
  'attachments.add': entry('attachments.add', z.object({ n: z.number(), chip: z.string() })),
  'attachments.expand': entry('attachments.expand', z.string()),
  'attachments.read': entry('attachments.read', z.object({ mime: z.string(), size: z.number(), data: z.string() })),
  'network.status': entry('network.status', done),
  'network.friends.list': entry('network.friends.list', done),
  'network.dm.send': entry('network.dm.send', done),
  'network.dm.history': entry('network.dm.history', done),
  'network.groups.list': entry('network.groups.list', done),
  'network.groups.send': entry('network.groups.send', done),
  'network.groups.history': entry('network.groups.history', done),
  'network.groups.approve': entry('network.groups.approve', done),
  'network.groups.decline': entry('network.groups.decline', done),
  'network.presence.set': entry('network.presence.set', done),
  'network.presence.get': entry('network.presence.get', done),
  'network.post': entry('network.post', done),
  'network.files.addData': entry('network.files.addData', done),
  'network.files.download': entry('network.files.download', done),
  'network.files.cancel': entry('network.files.cancel', done),
  'network.files.preview': entry('network.files.preview', z.object({ mime: z.string(), b64: z.string() }).passthrough().optional()),
  'network.channels.main': entry('network.channels.main', z.string().optional()),
  'network.read': entry('network.read', done),
  'claudeCode.outputs': entry('claudeCode.outputs', done),
  'claudeCode.output': entry('claudeCode.output', done),
  'claudeCode.taskOutput': entry('claudeCode.taskOutput', done),
  'gateway.list': entry('gateway.list', done),
  'gateway.confirm': entry('gateway.confirm', done),
  'gateway.cancel': entry('gateway.cancel', done),
  'gateway.ask': entry('gateway.ask', done),
  'gateway.decide': entry('gateway.decide', done),
  'gateway.answer': entry('gateway.answer', done),
  'gateway.image': entry('gateway.image', z.string()),
  'board.comment': entry('board.comment', done),
  'board.move': entry('board.move', done),
  'plans.approve': entry('plans.approve', done),
  'plans.discard': entry('plans.discard', done),
  'plans.pass': entry('plans.pass', done),
  'plans.recheck': entry('plans.recheck', done),
  'plans.sendBack': entry('plans.sendBack', done),
  'companion.older': entry('companion.older', OlderResult),
  'companion.ask': entry('companion.ask', AskResult),
  'companion.post': entry('companion.post', done),
  'companion.askPerson': entry('companion.askPerson', AskPersonResult),
  'companion.signOut': entry('companion.signOut', z.object({ signedOut: z.literal(true) })),
  'companion.openOnMac': entry('companion.openOnMac', OpenOnMacResult),
  'companion.icon': entry('companion.icon', IconResult),
  'companion.mergeCheck': entry('companion.mergeCheck', MergeCheckView),
  'companion.merge': entry('companion.merge', MergeView),
  'companion.resolve': entry('companion.resolve', MergeView),
  'companion.viewFetch': entry('companion.viewFetch', done),
  'companion.draftTask': entry('companion.draftTask', TaskDraftResult),
  'companion.addTask': entry('companion.addTask', z.object({ id: z.string(), key: z.string() })),
  'board.start': entry('board.start', z.string()),
} as const;

export type PhoneMethod = keyof typeof PhoneCalls;
export type PhoneArgs<M extends PhoneMethod> = z.input<(typeof PhoneCalls)[M]['args']>;
export type PhoneResult<M extends PhoneMethod> = z.infer<(typeof PhoneCalls)[M]['result']>;
