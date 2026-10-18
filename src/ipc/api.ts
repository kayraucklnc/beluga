import { z } from 'zod';
import { ClaudeAnswer, GuestCan, WsRole } from '../protocol.js';
import { EFFORTS, NotifySettings, THEMES, TRUST_LEVELS } from '../shared/settings-schema.js';

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
    model: z.string().max(80).optional(),
    effort: z.enum(EFFORTS).optional(),
    autoSetup: bool,
    contextMeter: bool,
    subagents: z.enum(['full', 'compact', 'hidden']),
    hiddenButtons: z.array(z.string().max(40)).max(40),
    friendWorktrees: z.enum(['ask', 'off']),
    shell: z.string().max(200).optional(),
  })
  .partial();

const WorkspaceTab = z.enum(['chat', 'files', 'review', 'terminal']);
const Policy = z.enum(['ask', 'auto', 'deny']);
const Answer = z.enum(['yes', 'no', 'always']);
const LinkOptions = z.object({ scope: id, can: GuestCan, knock: bool, singleUse: bool, expiresInMs: z.number().int().min(0) });
const GuestPatch = z.object({ addProject: opt(id), room: opt(bool), can: opt(GuestCan) });
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
  'session.quit': args(),
  'session.serveFolder': args(id, path, z.array(id).max(50)),
  'session.localLocation': args(path, bool),
  'session.testNotification': args(),

  // ---- your Claude's queue and approvals
  'host.answerApproval': args(Answer, id),
  'host.promote': args(id),
  'host.cancelQueued': args(id),

  // ---- the inbox
  'inbox.read': args(opt(z.object({ channel: opt(channel), id: opt(z.number().int()) }))),
  'inbox.clear': args(),

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
  'files.download': args(Location),
  'files.downloadSpec': args(z.string().max(4096)),
  'files.closeViewer': args(),
  'files.readImage': args(),

  // ---- projects and workspaces
  'workspaces.open': args(id, opt(WorkspaceTab)),
  'workspaces.refresh': args(),
  'workspaces.newWorktree': args(id, z.string().max(200)),
  'workspaces.newChat': args(id, z.string().max(200), opt(path)),
  'workspaces.startChat': args(id, str, opt(path)),
  'workspaces.startWorktree': args(id, str),
  'workspaces.fork': args(id, z.string().max(200)),
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
  'workspaces.hideProject': args(id),
  'workspaces.cleanAgentWorktrees': args(id),
  'workspaces.addProject': args(path),
  'workspaces.addFolder': args(path),
  'workspaces.selectFile': args(z.number().int().min(0)),

  // ---- runs, scripts, pull requests, models, search, templates
  'workbench.run': args(id),
  'workbench.stopRun': args(id),
  'workbench.runSetup': args(id),
  'workbench.setScript': args(id, z.enum(['setup', 'run']), z.string().max(2000)),
  'workbench.shareScripts': args(id),
  'workbench.setModel': args(opt(channel), z.string().max(80)),
  'workbench.createPr': args(id, opt(str)),
  'workbench.fixChecks': args(id),
  'workbench.openPr': args(id),
  'workbench.refreshPrs': args(opt(id)),
  'workbench.editPrPrompt': args(),
  'workbench.resetPrPrompt': args(),
  'workbench.measureDisk': args(),
  'workbench.search': args(z.string().max(500)),
  'workbench.openHit': args(z.number().int().min(0)),
  'workbench.saveTemplate': args(str),
  'workbench.removeTemplate': args(id),

  // ---- terminals (the bytes themselves stream separately; see protocol.ts)
  'terminals.shell': args(id, opt(TermSize)),
  'terminals.global': args(id, path, opt(TermSize)),
  'terminals.close': args(id),

  // ---- images in a message (screens without their own disk access: the Mac app)
  'attachments.add': args(z.enum(['png', 'jpg', 'jpeg', 'gif', 'webp']), z.string().max(6_000_000)),
  'attachments.expand': args(str, channel),

  // ---- klaud itself
  'daemon.stop': args(),

  // ---- this computer
  'local.listDirs': args(path),
  'local.openFolder': args(path),
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
