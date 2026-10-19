import { z } from 'zod';
import { ClaudeAnswer, GuestCan, WsRole } from '../protocol.js';
import { EFFORTS, NotifySettings, THEMES, TRUST_LEVELS } from '../shared/settings-schema.js';
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN } from '../shared/context-usage.js';
import { ENV_KEY, MAX_ENV_VALUE, MAX_ENV_VARS } from '../shared/env-vars.js';
import { NETWORK_API } from './network-api.js';
import { STRIPE_API } from './stripe-api.js';
import { CLAUDE_CODE_API } from './claude-code-api.js';
import { STEPS_API } from './steps-api.js';
import { GATEWAY_API } from './gateway-api.js';
import { GIT_API } from './git-api.js';

/**
 * Everything a client can ask klaud to do, in one list. The daemon validates every call
 * against it (handlers.ts implements each one), and both clients call through it, so the
 * terminal UI and the Mac app can't drift apart. Browser-safe: no Node imports.
 *
 * Each entry is the method's arguments as a zod tuple. Results are typed from the handlers.
 */

const str = z.string().max(64_000);
const id = z.string().min(1).max(200);
const channel = z.string().min(1).max(200);
const path = z.string().max(4096);
const bool = z.boolean();
const opt = <T extends z.ZodType>(t: T) => t.optional();
function args(): { args: z.ZodTuple<[], null> };
function args<T extends [z.ZodType, ...z.ZodType[]]>(...items: T): { args: z.ZodTuple<T, null> };
function args(...items: z.ZodType[]): { args: z.ZodTuple } {
  return { args: items.length ? z.tuple(items as [z.ZodType, ...z.ZodType[]]) : z.tuple([]) };
}

export const Location = z.object({ owner: id, share: z.string().min(1).max(200), path });

/** A settings change (no defaults: only the keys you send change). */
export const PrefsPatch = z
  .object({
    theme: z.enum(THEMES),
    mouse: bool,
    tunnel: z.enum(['auto', 'p2p', 'cloudflared', 'ngrok', 'none']),
    selfApproval: z.enum(['never', 'ask']),
    notify: NotifySettings,
    // null: back to the default (JSON can't carry undefined, so "unset" travels as null).
    model: z.string().max(80).nullable().optional(),
    effort: z.enum(EFFORTS).nullable().optional(),
    autoSetup: bool,
    contextMeter: bool,
    autoCompact: bool,
    autoCompactAt: z.number().int().min(AUTO_COMPACT_MIN).max(AUTO_COMPACT_MAX),
    subagents: z.enum(['full', 'compact', 'hidden']),
    hiddenButtons: z.array(z.string().max(40)).max(40),
    friendWorktrees: z.enum(['ask', 'off']),
    chatClaude: z.enum(['everyone', 'trusted', 'off']),
    shell: z.string().max(200).optional(),
    shellLogin: bool,
    shellArgs: z.array(z.string().max(200)).max(20),
    earningsCurrency: z.string().regex(/^[a-z]{3}$/).nullable().optional(),
  })
  .partial();

/** Environment variables for one place (names checked; empty rows are skipped). */
const EnvRows = z.array(z.object({ key: z.union([z.literal(''), z.string().regex(ENV_KEY, 'Use letters, digits and _ only').max(200)]), value: z.string().max(MAX_ENV_VALUE) })).max(MAX_ENV_VARS + 50);

const WorkspaceTab = z.enum(['chat', 'files', 'review', 'terminal']);
const Policy = z.enum(['ask', 'auto', 'deny']);
const Answer = z.enum(['yes', 'no', 'always']);
const LinkOptions = z.object({ scope: id, can: GuestCan, knock: bool, singleUse: bool, expiresInMs: z.number().int().min(0) });
const GuestPatch = z.object({ addProject: opt(id), room: opt(bool), can: opt(GuestCan) });
/** A project (by id) or a group (by name) in the sidebar's arrangement. */
const ArrangeTarget = z.union([z.object({ project: id }).strict(), z.object({ group: z.string().min(1).max(80) }).strict()]);
const TermSize = z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) });

export const API = {
  // ---- the room, chat and your preferences
  'session.submit': args(str, opt(z.object({ channel: opt(channel), urgent: opt(bool) }))),
  'session.copyInvite': args(),
  'session.copyLastAnswer': args(),
  'session.copyText': args(str, z.string().max(500)),
  'session.setPrefs': args(PrefsPatch),
  'session.setPlanMode': args(channel, bool),
  'session.setClaudeSharing': args(Policy),
  'session.rename': args(z.string().max(64)),
  'session.zoom': args(z.enum(['in', 'out', 'reset'])),
  'session.shareFolder': args(path, opt(bool), opt(z.array(id).max(50))),
  'session.unshareFolder': args(id),
  'session.follow': args(opt(z.string().max(64))),
  'session.clearChat': args(channel, opt(z.object({ everyone: opt(bool), fresh: opt(bool) }))),
  'session.removePerson': args(id),
  'session.newInviteLink': args(),
  'session.setRoomOpen': args(bool),
  'session.setFriendWorktrees': args(z.enum(['ask', 'off'])),
  'session.setAccess': args(id, z.enum(['folder', 'full'])),
  'session.runOnPeerByHand': args(z.string().max(64), str, opt(channel)),
  'session.stopAgent': args(),
  'session.compact': args(channel, opt(z.string().max(2000))),
  'session.quit': args(),
  'session.serveFolder': args(id, path, z.array(id).max(50)),
  'session.localLocation': args(path, bool),
  'session.testNotification': args(),

  // ---- your Claude's queue and approvals
  'host.answerApproval': args(Answer, id),
  'host.promote': args(id),
  // Stop your Claude in one conversation: → { stopped, returned: your queued prompts, in order }.
  'host.stopRun': args(channel),
  'host.cancelQueued': args(id),
  'host.reorderQueued': args(id, z.number().int().min(0).max(100)),

  // ---- the inbox
  'inbox.read': args(opt(z.object({ channel: opt(channel), id: opt(z.number().int()) }))),
  'inbox.unread': args(z.number().int()),
  'inbox.clear': args(opt(z.object({ id: opt(z.number().int()) }))),

  // ---- Claude's questions and plans
  'questions.answer': args(id, ClaudeAnswer),
  'questions.pick': args(id, z.string().max(2000), z.string().max(4000)),

  // ---- people and trust
  'people.setTrust': args(id, z.enum(TRUST_LEVELS)),
  'people.dismissPrompt': args(id),
  'people.forget': args(id),

  // ---- workspaces you share, and ones shared with you
  'sharing.invite': args(id, id, WsRole),
  'sharing.remove': args(id, id),
  'sharing.leave': args(id, id),

  // ---- links into one project (or everything)
  'invites.create': args(LinkOptions),
  'invites.revoke': args(id),
  'invites.copyLink': args(id),
  'invites.letIn': args(id, opt(GuestCan)),
  'invites.decline': args(id),
  'invites.change': args(id, GuestPatch),
  'invites.remove': args(id),

  // ---- work on a friend's computer
  'remote.requestWorktree': args(id, z.string().max(80), str, opt(bool)),
  'remote.handoff': args(id, id),

  // ---- a workspace shared with you: what changed, and its read-only shell
  'diff.load': args(id),
  'diff.select': args(z.number().int().min(0)),
  'shell.run': args(id, z.string().max(2000)),
  'shell.openEntry': args(id, path, bool),

  // ---- shared files: browsing, the viewer, downloads
  'files.browseTo': args(Location),
  'files.enter': args(z.number().int().min(0)),
  'files.up': args(),
  'files.loadDir': args(Location),
  'files.open': args(Location, opt(z.object({ by: opt(z.string().max(80)), broadcast: opt(bool) }))),
  'files.openSpec': args(z.string().max(4096)),
  // `to`: save exactly there (an absolute path from a Save dialog) instead of ~/Downloads/klaud.
  'files.download': args(Location, opt(z.object({ to: opt(path) }))),
  'files.downloadSpec': args(z.string().max(4096)),
  'files.closeViewer': args(),
  'files.readImage': args(),
  // An image a document points at (Markdown's ![](diagram.png)), read the way files.open reads one: → { mediaType, data (base64) }.
  'files.readImageFile': args(Location),

  // ---- projects and workspaces
  'workspaces.open': args(id, opt(WorkspaceTab)),
  // Load a workspace's saved conversation without going there (the Mac Overview's read-only look at an archived one).
  'workspaces.load': args(id),
  'workspaces.refresh': args(),
  'workspaces.newWorktree': args(id, z.string().max(200), opt(z.object({ base: opt(z.string().min(1).max(250)) }))),
  'workspaces.newChat': args(id, z.string().max(200), opt(path)),
  'workspaces.startChat': args(id, str, opt(path)),
  'workspaces.startWorktree': args(id, str, opt(z.object({ base: opt(z.string().min(1).max(250)), name: opt(z.string().max(200)) }))),
  // What a new worktree can start from: → { base: the default, branches: default first, then newest }.
  'workspaces.branches': args(id),
  'workspaces.fork': args(id, z.string().max(200)),
  // Carry a conversation (an ask chat in a main folder, or any chat) into a new worktree and go on there → the new workspace's id.
  'workspaces.continueInWorktree': args(id, opt(z.object({ task: opt(str), base: opt(z.string().min(1).max(250)), name: opt(z.string().max(200)) }).strict())),
  'workspaces.archive': args(id, opt(bool)),
  'workspaces.restore': args(id),
  'workspaces.remove': args(id),
  'workspaces.commit': args(id, opt(z.string().max(2000))),
  'workspaces.merge': args(id),
  'workspaces.prepareRemoval': args(id),
  'workspaces.applyEnvBack': args(id),
  'workspaces.askClaudeToReview': args(id),
  'workspaces.askClaudeToMerge': args(id),
  'workspaces.compact': args(id, opt(z.string().max(2000))),
  'workspaces.openInFinder': args(id),
  'workspaces.setGroup': args(id, opt(z.string().max(80))),
  'workspaces.renameGroup': args(z.string().min(1).max(80), z.string().max(80)),
  'workspaces.ungroup': args(z.string().min(1).max(80)),
  // Arranging the sidebar: move a project (into a group or to the top level) or a group, before another item or last.
  'workspaces.arrange': args(ArrangeTarget, opt(z.object({ into: opt(z.string().min(1).max(80).nullable()), before: opt(ArrangeTarget.nullable()) }).strict())),
  // A new empty group, before an item or last; with a project, it moves in. → its name.
  'workspaces.newGroup': args(z.string().min(1).max(80), opt(z.object({ before: opt(ArrangeTarget.nullable()), project: opt(id) }).strict())),
  'workspaces.showProject': args(path),
  'workspaces.hideProject': args(id),
  'workspaces.cleanAgentWorktrees': args(id),
  // Worktrees klaud didn't make (Conductor's, Claude Code's, a script's): who made them, their info page, tidying up.
  'workspaces.otherOrigins': args(id),
  // When each one last changed (git's view): the Mac sidebar lists them most recent first.
  'workspaces.otherActivity': args(id),
  'workspaces.worktreeInfo': args(id),
  'workspaces.showConversation': args(id, z.string().min(1).max(100)),
  'workspaces.removeOther': args(id, opt(bool)),
  'workspaces.staleOthers': args(id, opt(z.enum(['conductor', 'claude', 'other']))),
  'workspaces.cleanUpOthers': args(id, z.array(id).max(500)),
  'workspaces.addProject': args(path),
  'workspaces.addFolder': args(path),
  'workspaces.selectFile': args(z.number().int().min(0)),
  // Load (or reload) what changed in a workspace without going to it (the Mac app's Changes panel).
  'workspaces.review': args(id),

  // ---- runs, scripts, pull requests, models, search, templates
  'workbench.run': args(id),
  'workbench.stopRun': args(id),
  'workbench.runSetup': args(id),
  'workbench.setScript': args(id, z.enum(['setup', 'run']), z.string().max(2000), opt(bool)),
  'workbench.shareScripts': args(id),
  'workbench.setModel': args(opt(channel), z.string().max(80)),
  'workbench.createPr': args(id, opt(str)),
  'workbench.fixChecks': args(id),
  'workbench.openPr': args(id),
  'workbench.refreshPrs': args(opt(id), opt(bool)),
  'workbench.editPrPrompt': args(),
  'workbench.resetPrPrompt': args(),
  'workbench.measureDisk': args(),
  'workbench.search': args(z.string().max(500)),
  'workbench.openHit': args(z.number().int().min(0)),
  'workbench.saveTemplate': args(str, opt(bool)),
  'workbench.removeTemplate': args(id),

  // ---- terminals (the bytes themselves stream separately; see protocol.ts)
  'terminals.shell': args(id, opt(TermSize)),
  'terminals.global': args(id, path, opt(TermSize)),
  'terminals.close': args(id),
  'terminals.rename': args(id, z.string().max(200)),

  // ---- your environment variables (no project: yours everywhere; else that project's)
  'env.get': args(opt(id)),
  'env.set': args(opt(id), EnvRows, opt(bool)),

  // ---- images in a message (screens without their own disk access: the Mac app)
  'attachments.add': args(z.enum(['png', 'jpg', 'jpeg', 'gif', 'webp']), z.string().max(6_000_000)),
  'attachments.expand': args(str, channel),
  // An image linked in a message (owner peer id, file name): its bytes to show, or opened in Preview.
  'attachments.read': args(id, z.string().min(1).max(255)),
  'attachments.open': args(id, z.string().min(1).max(255)),

  // ---- klaud itself
  'daemon.stop': args(),

  // ---- projects on this computer: their icons, adding them
  'projects.icon': args(id),
  'projects.setIcon': args(id, opt(path)),
  'projects.add': args(path),
  'projects.addFolder': args(path),
  'projects.suggest': args(),
  // The icon of a folder that isn't a project yet (one of the suggestions).
  'projects.iconAt': args(path),

  // ---- this computer
  'local.listDirs': args(path),
  'local.openFolder': args(path),

  // ---- the klaud network: friends, direct messages, groups, your status (network-api.ts)
  ...NETWORK_API,

  // ---- earnings from Stripe, per project (stripe-api.ts)
  ...STRIPE_API,
  ...CLAUDE_CODE_API,
  ...STEPS_API,
  ...GATEWAY_API,
  // ---- git: keeping main current, GitHub, history (git-api.ts)
  ...GIT_API,
} as const;

export type Api = typeof API;
export type Method = keyof Api;
export type Args<M extends Method> = z.infer<Api[M]['args']>;

export const METHODS = Object.keys(API) as Method[];

export const isMethod = (name: string): name is Method => Object.hasOwn(API, name);

/** Check a call's arguments (the daemon does this for every call it gets). */
export function parseArgs<M extends Method>(method: M, raw: unknown): Args<M> {
  const parsed = API[method].args.safeParse(raw);
  if (!parsed.success) throw new Error(`Bad arguments for ${method}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data as Args<M>;
}
