import type { Session } from './session.js';
import { type Policy, channelOf } from './store.js';
import { THEMES, type ThemeName } from './settings.js';

export interface CommandSpec {
  readonly name: string;
  readonly args?: string;
  readonly desc: string;
}

/** Single source of truth for autocomplete and the help screen. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'invite', desc: 'copy the invite link for friends' },
  { name: 'overview', desc: 'see every worktree at a glance' },
  { name: 'room', desc: 'back to the room chat' },
  { name: 'new', args: '<name>', desc: 'new worktree from the latest origin (in the current project)' },
  { name: 'chat', args: '<title>', desc: 'new Claude chat in the current project, no worktree' },
  { name: 'review', desc: "see this workspace's changes" },
  { name: 'compact', args: '[focus]', desc: "shrink this conversation's context (Claude keeps what matters)" },
  { name: 'merge', desc: 'merge this worktree into the main folder' },
  { name: 'commit', args: '[message]', desc: 'commit all changes in this workspace' },
  { name: 'fork', args: '<name>', desc: 'copy this workspace and its conversation' },
  { name: 'finder', desc: 'open this workspace in Finder' },
  { name: 'archive', desc: 'archive this workspace (keeps branch and conversation)' },
  { name: 'restore', desc: 'bring an archived workspace back' },
  { name: 'delete', desc: 'delete this workspace, its branch and conversation' },
  { name: 'project', args: 'add <path>', desc: 'add a project, or "folder <path>" to watch a folder of projects' },
  { name: 'copy', desc: "copy the last Claude answer" },
  { name: 'follow', args: '<name>', desc: "follow someone's screen and their Claude" },
  { name: 'unfollow', desc: 'stop following' },
  { name: 'open', args: '<file>', desc: 'open a shared file live, e.g. /open bob:api/README.md' },
  { name: 'get', args: '<file>', desc: 'download a shared file to ~/Downloads/klaude' },
  { name: 'close', desc: 'close the file viewer' },
  { name: 'stop', desc: 'stop your Claude' },
  { name: 'policy', args: 'ask|auto|deny', desc: "how friends' requests for your Claude are handled" },
  { name: 'trust', args: '<name>', desc: "auto-approve someone's requests this session" },
  { name: 'untrust', args: '<name>', desc: 'require approval again' },
  { name: 'people', desc: "list everyone and what they share" },
  { name: 'share', args: '<folder> [rw]', desc: 'share a folder with the room (read-only unless rw)' },
  { name: 'unshare', args: '<name>', desc: 'stop sharing a folder' },
  { name: 'settings', desc: 'name, theme, sharing, mouse, remote access' },
  { name: 'name', args: '<new name>', desc: 'change the name friends see' },
  { name: 'theme', args: 'calm|light|contrast|mono', desc: 'switch the color theme' },
  { name: 'zoom', args: 'in|out|reset', desc: 'make the text bigger or smaller (also Option+↑ / Option+↓)' },
  { name: 'clear', desc: 'clear this conversation (choose: just you, everyone, or a fresh Claude)' },
  { name: 'plan', args: 'on|off', desc: 'Claude plans first and asks you to approve before changing anything' },
  { name: 'remove', args: '<name>', desc: 'host: remove someone from the room (the invite link changes)' },
  { name: 'newlink', desc: 'host: make a new invite link; the old one stops working' },
  { name: 'lock', args: 'on|off', desc: 'host: stop (or allow) new people joining' },
  { name: 'help', desc: 'show keys and commands' },
  { name: 'quit', desc: 'leave the room' },
];

const POLICIES: readonly Policy[] = ['ask', 'auto', 'deny'];

/** Execute a `/command` (or legacy `:command`). */
export function runCommand(session: Session, name: string, args: readonly string[]): void {
  const state = session.store.getState();
  const arg = args[0];
  switch (name) {
    case 'q':
    case 'quit':
    case 'exit':
      session.quit();
      return;
    case 'h':
    case 'help':
    case '?':
      session.store.dispatch({ type: 'overlay', overlay: 'help' });
      return;
    case 'invite':
      void session.copyInvite();
      return;
    case 'overview':
    case 'projects':
    case 'workspaces':
      session.store.dispatch({ type: 'view', view: { kind: 'overview' } });
      return;
    case 'room':
    case 'lobby':
      session.store.dispatch({ type: 'view', view: { kind: 'room' } });
      return;
    case 'new':
    case 'worktree':
    case 'chat':
    case 'review':
    case 'compact':
    case 'merge':
    case 'commit':
    case 'fork':
    case 'finder':
    case 'archive':
    case 'restore':
    case 'delete':
    case 'project':
      runWorkspaceCommand(session, name, args);
      return;
    case 'copy':
      void session.copyLastAnswer();
      return;
    case 'open':
    case 'e':
      if (!arg) return session.toast('Usage: /open <name>:<folder>/<file>', 'warn');
      session.openSpec(arg);
      return;
    case 'get':
    case 'download':
      if (!arg) return session.toast('Usage: /get <name>:<folder>/<file>', 'warn');
      session.downloadSpec(arg);
      return;
    case 'close':
      session.store.dispatch({ type: 'viewer_close' });
      return;
    case 'follow':
      session.follow(arg);
      return;
    case 'unfollow':
      session.follow(undefined);
      return;
    case 'people':
    case 'peers':
    case 'who':
      for (const p of state.peers) {
        const shares = p.shares.map((s) => `${s.name}${s.writable ? '' : ' (read-only)'}`).join(', ') || 'nothing';
        session.system(`${p.name}${p.peerId === session.selfId ? ' (you)' : ''} · claude ${p.agent ? 'on' : 'off'} · shares ${shares}`);
      }
      return;
    case 'stop':
      session.stopAgent();
      return;
    case 'share': {
      if (!arg) return session.toast('Usage: /share <folder> [rw]', 'warn');
      session.shareFolder(arg.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'), args[1] === 'rw');
      return;
    }
    case 'unshare':
      if (!arg) return session.toast('Usage: /unshare <name>', 'warn');
      session.unshareFolder(arg);
      return;
    case 'policy':
      if (!arg || !POLICIES.includes(arg as Policy)) return session.toast(`Policy is "${state.policy}". Use /policy ask, auto or deny`);
      session.setClaudeSharing(arg as Policy);
      session.toast(`Friends' requests for your Claude: ${arg}`, 'success');
      return;
    case 'trust':
    case 'untrust': {
      const peer = arg ? session.findPeer(arg) : undefined;
      if (!peer) return session.toast(`Usage: /${name} <name>`, 'warn');
      session.store.dispatch({ type: 'trust', peerId: peer.peerId, trusted: name === 'trust' });
      session.toast(name === 'trust' ? `${peer.name}'s requests are auto-approved` : `${peer.name}'s requests need approval again`, 'success');
      return;
    }
    case 'y':
    case 'yes':
    case 'n':
    case 'no':
    case 'a':
    case 'always': {
      const answer = name.startsWith('y') ? 'yes' : name.startsWith('n') ? 'no' : 'always';
      if (!session.answerApproval(answer)) session.toast('Nothing to approve');
      return;
    }
    case 'clear':
      session.store.dispatch({ type: 'overlay', overlay: 'clear' });
      return;
    case 'plan': {
      const channel = channelOf(state.view);
      session.setPlanMode(channel, arg ? arg !== 'off' : !state.planMode[channel]);
      return;
    }
    case 'remove': {
      const target = state.peers.find((p) => p.name.toLowerCase() === (arg ?? '').toLowerCase());
      if (!session.isHost) return session.toast('Only the host can remove people', 'warn');
      if (!target) return session.toast(`Nobody called "${arg}" is here`, 'warn');
      session.removePerson(target.peerId);
      return;
    }
    case 'newlink':
      session.newInviteLink();
      return;
    case 'lock':
      session.setRoomOpen(arg === 'off');
      return;
    case 'settings':
    case 'prefs':
      session.store.dispatch({ type: 'overlay', overlay: 'settings' });
      return;
    case 'name':
      session.rename(args.join(''));
      return;
    case 'zoom':
    case 'text': {
      const dir = arg === 'out' || arg === 'smaller' || arg === '-' ? 'out' : arg === 'reset' || arg === '0' ? 'reset' : 'in';
      void session.zoom(dir);
      return;
    }
    case 'theme':
      if (!arg || !THEMES.includes(arg as ThemeName)) return session.toast(`Themes: ${THEMES.join(', ')}`);
      session.setPrefs({ theme: arg as ThemeName });
      session.toast(`Theme: ${arg}`, 'success');
      return;
    default:
      session.toast(`Unknown command /${name}. Type /help (or // to send a message starting with /)`, 'warn');
  }
}

/** Workspace commands act on the workspace you're looking at (or its project). */
function runWorkspaceCommand(session: Session, name: string, args: readonly string[]): void {
  const ctl = session.workspaces;
  if (!ctl) return session.toast('Projects are not available in this mode', 'warn');
  const text = args.join(' ').trim();
  if (name === 'project') {
    const [sub, ...rest] = args;
    const dir = rest.join(' ').replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
    if (!dir || (sub !== 'add' && sub !== 'folder')) return session.toast('Usage: /project add <path>  or  /project folder <path>', 'warn');
    void (sub === 'add' ? ctl.addProject(dir) : ctl.addFolder(dir));
    return;
  }
  const ws = ctl.current();
  const repos = ctl.manager.list.filter((p) => p.root);
  const project = ws ? ctl.manager.list.find((p) => p.id === ws.projectId) : repos.length === 1 ? repos[0] : undefined;
  if (name === 'new' || name === 'worktree' || name === 'chat') {
    if (!project) return session.toast('Open a workspace in the project first (or use + New worktree under it)', 'warn');
    if (!text) return session.toast(`Usage: /${name} <${name === 'chat' ? 'title' : 'name'}>`, 'warn');
    void (name === 'chat' ? ctl.newChat(project.id, text) : ctl.newWorktree(project.id, text));
    return;
  }
  if (!ws) return session.toast('Open a workspace first (Projects on the left)', 'warn');
  switch (name) {
    case 'review':
      ctl.open(ws.id, 'review');
      return;
    case 'compact':
      ctl.compact(ws.id, text);
      return;
    case 'merge':
      void ctl.merge(ws.id);
      return;
    case 'commit':
      void ctl.commit(ws.id, text || undefined);
      return;
    case 'fork':
      if (!text) return session.toast('Usage: /fork <name>', 'warn');
      void ctl.fork(ws.id, text);
      return;
    case 'finder':
      ctl.openInFinder(ws.id);
      return;
    case 'archive':
      void ctl.archive(ws.id, args[0] === 'force');
      return;
    case 'restore':
      void ctl.restore(ws.id);
      return;
    case 'delete':
      void ctl.remove(ws.id);
      return;
  }
}
