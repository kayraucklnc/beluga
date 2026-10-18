import type { Expects, LiveState, Need, ResultStatus } from './protocol.js';

/**
 * Tasks between Claudes in the shared state (the Mac app draws them): what you sent and what
 * reached you, where each one is, and its result. No file bytes and nothing secret: files are
 * paths on this Mac. Browser-safe: the Mac app runs it.
 */

/**
 * Where a task is. `confirm`: your Claude wants to ask someone you don't trust yet, and waits
 * for you (Ask / Not now). `sent`: it left (or waits in your outbox). Then the other side's
 * states, then a result.
 */
export type TaskState = 'confirm' | 'sent' | LiveState | ResultStatus;

export const FINAL_STATES: readonly TaskState[] = ['done', 'declined', 'failed', 'cancelled'];
export const isFinal = (state: TaskState): state is ResultStatus => FINAL_STATES.includes(state);

export interface TaskFile {
  readonly name: string;
  readonly size: number;
  /** Where it was saved on this Mac (missing: it was too big to come with the result). */
  readonly path?: string;
}

export interface TaskOutcome {
  readonly status: ResultStatus;
  readonly summary: string;
  readonly data?: unknown;
  readonly files: readonly TaskFile[];
  readonly log: readonly string[];
  /** The data matches what was asked for (`expects`); problems say how it doesn't. */
  readonly valid?: boolean;
  readonly problems?: readonly string[];
}

export interface TaskView {
  readonly id: string;
  /** sent: from you (or your Claude) to them. received: from them to you. */
  readonly direction: 'sent' | 'received';
  /** The other person. */
  readonly peerId: string;
  readonly peerName: string;
  readonly kind: 'ask' | 'run';
  readonly ask: string;
  readonly needs: readonly Need[];
  readonly project?: string;
  readonly expects?: Expects;
  readonly deadline?: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutSec?: number;
  readonly by: 'agent' | 'person';
  /** Sent: the conversation your Claude asked from (its answer continues there). */
  readonly conversation?: string;
  readonly state: TaskState;
  /** The latest steps (short lines). */
  readonly steps: readonly string[];
  readonly result?: TaskOutcome;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Sent: the result was given to your Claude (it waited for it, or a new turn started with it). */
  readonly delivered?: boolean;
  /** Received: where it ran here ("landing", "a scratch folder"). */
  readonly where?: string;
}

/** What someone's klaud offers you (their card), as they told you. */
export interface PeerCard {
  readonly note?: string;
  /** How much they trust you. */
  readonly trust: 'blocked' | 'ask' | 'trusted' | 'full';
  readonly offers: readonly Need[];
  readonly projects: readonly string[];
  readonly claude: boolean;
  readonly at: number;
}

export interface GatewayState {
  readonly enabled: boolean;
  /** Newest last, at most KEEP_TASKS. */
  readonly tasks: readonly TaskView[];
  /** By peer id. */
  readonly cards: Readonly<Record<string, PeerCard>>;
  /** Your own "Ask me for…" note. */
  readonly note: string;
}

export interface GatewaySlice {
  readonly gateway: GatewayState;
}

export const KEEP_TASKS = 200;

export const NO_GATEWAY: GatewayState = { enabled: false, tasks: [], cards: {}, note: '' };
export const initialGateway: GatewaySlice = { gateway: NO_GATEWAY };

export type GatewayAction =
  /** Everything at once (on start). */
  | { type: 'gw_init'; state: GatewayState }
  /** One task changed (same id: replaced). */
  | { type: 'gw_task'; task: TaskView }
  | { type: 'gw_card'; peerId: string; card: PeerCard }
  | { type: 'gw_note'; note: string }
  | { type: 'gw_off' };

function withTask(list: readonly TaskView[], task: TaskView): readonly TaskView[] {
  const at = list.findIndex((t) => t.id === task.id);
  if (at >= 0) return list.map((t, i) => (i === at ? task : t));
  return [...list, task].slice(-KEEP_TASKS);
}

export function reduceGateway(state: GatewaySlice, action: GatewayAction): GatewaySlice {
  switch (action.type) {
    case 'gw_init':
      return { gateway: action.state };
    case 'gw_task':
      return { gateway: { ...state.gateway, tasks: withTask(state.gateway.tasks, action.task) } };
    case 'gw_card':
      return { gateway: { ...state.gateway, cards: { ...state.gateway.cards, [action.peerId]: action.card } } };
    case 'gw_note':
      return { gateway: { ...state.gateway, note: action.note } };
    case 'gw_off':
      return { gateway: NO_GATEWAY };
    default:
      return state;
  }
}

// ---- for screens

/** One line of an ask, for titles ("Kayra's Claude wants to: …"). */
export const oneLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The approval card's title for a request that reached you (screens find the card by it). */
export const approvalTitle = (t: Pick<TaskView, 'peerName' | 'by' | 'ask'>): string => `${t.peerName}${t.by === 'agent' ? "'s Claude" : ''} wants to: ${oneLine(t.ask)}`;

/** Tasks shown in a conversation (sent from it), oldest first. */
export const tasksIn = (state: GatewaySlice, channel: string): readonly TaskView[] => state.gateway.tasks.filter((t) => t.direction === 'sent' && t.conversation === channel);

/** "bob's Claude", or "bob's Mac" for a command. */
export const targetLabel = (t: Pick<TaskView, 'peerName' | 'kind'>): string => (t.kind === 'run' ? `${t.peerName}’s Mac` : `${t.peerName}’s Claude`);

/** Plain words for where a task is, from the point of view of the one looking. */
export function stateLabel(t: TaskView): string {
  const them = t.peerName;
  if (t.direction === 'received') {
    switch (t.state) {
      case 'queued':
        return 'Queued';
      case 'awaiting_approval':
        return 'Waiting for you to approve';
      case 'working':
        return t.kind === 'run' ? 'Running' : 'Your Claude is working';
      case 'done':
        return 'Done';
      case 'declined':
        return 'Declined';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return `${them} cancelled it`;
      default:
        return 'Received';
    }
  }
  switch (t.state) {
    case 'confirm':
      return 'Waiting for you';
    case 'sent':
      return `Sent · waiting for ${them}`;
    case 'queued':
      return `In ${them}’s queue`;
    case 'awaiting_approval':
      return `Waiting for ${them} to approve`;
    case 'working':
      return t.kind === 'run' ? `Running on ${them}’s Mac` : `${them}’s Claude is working`;
    case 'done':
      return 'Done';
    case 'declined':
      return `${them} declined`;
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** A tone for the state (screens color the dot and label by it). */
export function stateTone(t: TaskView): 'claude' | 'ok' | 'warn' | 'error' | 'muted' {
  switch (t.state) {
    case 'done':
      return t.result?.valid === false ? 'warn' : 'ok';
    case 'declined':
    case 'confirm':
    case 'awaiting_approval':
      return 'warn';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'muted';
    default:
      return 'claude';
  }
}
