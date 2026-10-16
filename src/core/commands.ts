import type { Session } from './session.js';
import type { Policy } from './store.js';

export const HELP_TEXT = [
  'Talking',
  '  hello everyone          group chat',
  '  @claude <task>          your claude (your machine, your subscription)',
  '  @claude:bob <task>      bob\'s claude (runs on bob\'s machine, needs his OK)',
  '  @claudes <task>         every claude in the room at once',
  'Keys (NORMAL mode)',
  '  i / Enter  type      :  command      Tab  next pane      q  quit',
  '  j/k  move/scroll     l/Enter  open   h/-  up a folder     y/n/a  answer approval',
  'Commands',
  '  :open bob:proj/README.md   view a file live      :close     close viewer',
  '  :follow bob                follow bob & his claude like Google Docs',
  '  :unfollow                  stop following         :peers     who is here',
  '  :invite                    show the invite code   :stop      stop your claude',
  '  :policy ask|auto|deny      how to treat requests for your claude from friends',
  '  :trust bob / :untrust bob  auto-approve bob\'s requests',
  '  :clear  :help  :q',
];

const POLICIES: readonly Policy[] = ['ask', 'auto', 'deny'];

/** Execute a `:command`. Kept separate from Session so it stays small and testable. */
export function runCommand(session: Session, name: string, args: readonly string[]): void {
  const state = session.store.getState();
  const arg = args[0];
  switch (name) {
    case 'q':
    case 'quit':
    case 'qa':
      session.quit();
      return;
    case 'h':
    case 'help':
      for (const line of HELP_TEXT) session.system(line);
      return;
    case 'open':
    case 'e':
      if (!arg) return session.system('Usage: :open <peer>:<share>/<path>', 'warn');
      session.openSpec(arg);
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
    case 'peers':
    case 'who':
      for (const p of state.peers) {
        const shares = p.shares.map((s) => `${s.name}${s.writable ? '' : '(ro)'}`).join(', ') || 'no shares';
        session.system(`${p.peerId === session.selfId ? '* ' : '  '}${p.name}  agent:${p.agent ? 'on' : 'off'}  shares: ${shares}`);
      }
      return;
    case 'invite':
      session.system(state.invite ? `Invite: ${state.invite}` : 'Only the host has the invite code (ask them)');
      return;
    case 'stop':
      session.stopAgent();
      return;
    case 'policy':
      if (!arg || !POLICIES.includes(arg as Policy)) return session.system(`Policy is "${state.policy}". Usage: :policy ask|auto|deny`);
      session.store.dispatch({ type: 'policy', policy: arg as Policy });
      session.system(`Requests for your claude: ${arg}`);
      return;
    case 'trust':
    case 'untrust': {
      const peer = arg ? session.findPeer(arg) : undefined;
      if (!peer) return session.system(`Usage: :${name} <peer>`, 'warn');
      session.store.dispatch({ type: 'trust', peerId: peer.peerId, trusted: name === 'trust' });
      session.system(name === 'trust' ? `${peer.name}'s requests are auto-approved` : `${peer.name}'s requests need approval again`);
      return;
    }
    case 'y':
    case 'yes':
    case 'n':
    case 'no':
    case 'a':
    case 'always': {
      const answer = name.startsWith('y') ? 'yes' : name.startsWith('n') ? 'no' : 'always';
      if (!session.answerApproval(answer)) session.system('Nothing to approve');
      return;
    }
    case 'clear':
      session.store.dispatch({ type: 'clear' });
      return;
    default:
      session.system(`Unknown command :${name} (try :help)`, 'warn');
  }
}
