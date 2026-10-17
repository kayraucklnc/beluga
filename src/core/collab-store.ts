import type { ClaudeQuestion, WsRole } from '../protocol.js';

/** Claude (yours or a friend's) is waiting for an answer from you. */
export interface PendingQuestion {
  readonly qid: string;
  readonly requestId: string;
  /** Whose Claude is asking. */
  readonly owner: string;
  readonly channel: string;
  readonly question: ClaudeQuestion;
  /** Answers picked so far, for multi-question prompts (question text → answer). */
  readonly picked: Readonly<Record<string, string>>;
}

/** A workspace someone shared with you. */
export interface SharedWorkspace {
  readonly owner: string;
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly branch?: string;
  readonly role: WsRole;
  /** The owner's share for its folder. */
  readonly share: string;
}

export interface RosterEntry {
  readonly peerId: string;
  readonly role: WsRole;
}

/** A folder someone shared with just you (or a few people). */
export interface Offer {
  readonly owner: string;
  readonly name: string;
  readonly writable: boolean;
}

export interface CollabState {
  /** Folders shared only with you. */
  readonly offers: readonly Offer[];
  readonly questions: readonly PendingQuestion[];
  /** Whether the room you host takes new people. */
  readonly roomOpen: boolean;
  /** Workspaces others shared with you. */
  readonly shared: readonly SharedWorkspace[];
  /** Your workspaces' members (workspace id → peer → role). */
  readonly members: Readonly<Record<string, Readonly<Record<string, WsRole>>>>;
  /** Who's in a workspace shared with you (as told by its owner). */
  readonly roster: Readonly<Record<string, readonly RosterEntry[]>>;
  /** Channels where the next request to Claude plans first. */
  readonly planMode: Readonly<Record<string, boolean>>;
  /** New people you haven't picked a trust level for yet (shown as a one-click card). */
  readonly trustPrompts: readonly string[];
}

export type CollabAction =
  | { type: 'question_add'; question: PendingQuestion }
  | { type: 'question_pick'; qid: string; question: string; answer: string }
  | { type: 'question_remove'; qid: string }
  | { type: 'room_open'; open: boolean }
  | { type: 'shared_add'; ws: SharedWorkspace }
  | { type: 'shared_remove'; owner: string; id: string }
  | { type: 'member_set'; id: string; peerId: string; role?: WsRole }
  | { type: 'roster'; id: string; members: readonly RosterEntry[] }
  | { type: 'plan_mode'; channel: string; on: boolean }
  | { type: 'peer_gone'; peerIds: readonly string[] }
  /** You left the room: everything shared with you goes. */
  | { type: 'shared_clear' }
  | { type: 'offer'; offer: Offer; active: boolean }
  | { type: 'trust_prompt'; peerId: string; show: boolean };

export const initialCollab: CollabState = { offers: [], questions: [], roomOpen: true, shared: [], members: {}, roster: {}, planMode: {}, trustPrompts: [] };

const MAX_QUESTIONS = 20;

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export function reduceCollab(state: CollabState, action: CollabAction): CollabState {
  switch (action.type) {
    case 'question_add':
      if (state.questions.some((q) => q.qid === action.question.qid)) return state;
      return { ...state, questions: [...state.questions, action.question].slice(-MAX_QUESTIONS) };
    case 'question_pick':
      return { ...state, questions: state.questions.map((q) => (q.qid === action.qid ? { ...q, picked: { ...q.picked, [action.question]: action.answer } } : q)) };
    case 'question_remove':
      return { ...state, questions: state.questions.filter((q) => q.qid !== action.qid) };
    case 'room_open':
      return { ...state, roomOpen: action.open };
    case 'shared_add':
      return { ...state, shared: [...state.shared.filter((w) => !(w.owner === action.ws.owner && w.id === action.ws.id)), action.ws] };
    case 'shared_remove':
      return { ...state, shared: state.shared.filter((w) => !(w.owner === action.owner && w.id === action.id)), roster: without(state.roster, action.id) };
    case 'member_set': {
      const current = state.members[action.id] ?? {};
      const next = action.role ? { ...current, [action.peerId]: action.role } : without(current, action.peerId);
      return { ...state, members: Object.keys(next).length ? { ...state.members, [action.id]: next } : without(state.members, action.id) };
    }
    case 'roster':
      return { ...state, roster: { ...state.roster, [action.id]: action.members } };
    case 'plan_mode':
      return { ...state, planMode: action.on ? { ...state.planMode, [action.channel]: true } : without(state.planMode, action.channel) };
    case 'shared_clear':
      return { ...state, shared: [], roster: {}, questions: [], offers: [] };
    case 'offer': {
      const rest = state.offers.filter((o) => !(o.owner === action.offer.owner && o.name === action.offer.name));
      return { ...state, offers: action.active ? [...rest, action.offer] : rest };
    }
    case 'peer_gone': {
      // Connections drop and come back (same identity), so seats and shares stay; their questions can't be answered.
      const gone = new Set(action.peerIds);
      return { ...state, questions: state.questions.filter((q) => !gone.has(q.owner)), trustPrompts: state.trustPrompts.filter((p) => !gone.has(p)) };
    }
    case 'trust_prompt': {
      const rest = state.trustPrompts.filter((p) => p !== action.peerId);
      return { ...state, trustPrompts: action.show ? [...rest, action.peerId] : rest };
    }
  }
}
