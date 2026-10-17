import type { Session } from './session.js';
import type { Policy } from './store.js';

export interface CommandSpec {
  readonly name: string;
  readonly args?: string;
  readonly desc: string;
}

/** Single source of truth for autocomplete and the help screen. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'invite', desc: 'copy the invite link for friends' },
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
  { name: 'clear', desc: 'clear the chat' },
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
      session.store.dispatch({ type: 'clear' });
      return;
    default:
      session.toast(`Unknown command /${name}. Type /help (or // to send a message starting with /)`, 'warn');
  }
}
