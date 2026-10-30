import { randomUUID } from 'node:crypto';
import type { AgentRef } from '../../protocol.js';
import type { Store } from '../store.js';
import { Chair, type DialogueTurnResult, type DialogueTurnRun } from './chair.js';
import { type Dialogue, DialogueError, type DialogueMode, type Participant, isOver, liveDialogueIn } from './model.js';
import { speakerName } from './prompt.js';
import { parseDialogueStart } from './start.js';

export interface DialoguesDeps {
  readonly store: Store;
  /** Where dialogues.json lives; unset: memory only (the demo). */
  readonly dir?: string;
  readonly selfId: () => string;
  readonly selfName: () => string;
  /** Your agents, by name: who a dialogue can be between. */
  readonly myAgents: () => readonly AgentRef[];
  /** Run one turn (core/agent-host runDialogueTurn on the participant's backend). */
  readonly runTurn: (run: DialogueTurnRun) => Promise<DialogueTurnResult>;
  readonly toast: (text: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface DialogueStartInput {
  readonly channel: string;
  readonly participants: readonly Participant[];
  readonly topic: string;
  readonly mode?: DialogueMode;
  readonly turnCap?: number;
  readonly budget?: number;
  /** Start now, without the confirm card (the API, when the screen already showed its caps). */
  readonly confirmed?: boolean;
}

/** What over says in the thread. */
function overLine(d: Dialogue): string {
  const turns = d.turns.filter((t) => t.by !== 'person').length;
  const head = d.status === 'ended' ? 'Dialogue ended' : d.status === 'stopped' ? 'Dialogue stopped' : d.status === 'budget' ? 'Dialogue halted' : 'Dialogue failed';
  return `${head} after ${turns} turn${turns === 1 ? '' : 's'}${d.note ? `: ${d.note}` : ''}`;
}

/**
 * Dialogues for the daemon (BLG-466): the chair (chair.ts) plus the room thread. Each change is put
 * in the store (the header card draws from it), each new turn becomes a chat line labeled with its
 * agent, and the end gets a line saying why. What you type into a conversation with a dialogue
 * going on lands in it as an interjection.
 */
export class Dialogues {
  readonly chair: Chair;
  /** Turns already in the chat, per dialogue. */
  private readonly posted = new Map<string, number>();

  constructor(private readonly deps: DialoguesDeps) {
    this.chair = new Chair({ ...(deps.dir ? { dir: deps.dir } : {}), runTurn: (run) => deps.runTurn(run), onChange: (d) => this.changed(d) });
    const all = this.chair.list();
    for (const d of all) this.posted.set(d.id, d.turns.length);
    deps.store.dispatch({ type: 'dialogues_init', dialogues: all });
    this.chair.resume();
  }

  /**
   * A line from the composer: a dialogue's start (proposed, for you to confirm), or what you say
   * into the one going on in this conversation. False: not for dialogues, it goes on as before.
   */
  fromComposer(raw: string, channel: string): boolean {
    const text = raw.trim();
    const live = liveDialogueIn(this.deps.store.getState(), channel);
    if (/^[/:]dialogue\s+stop$/i.test(text)) {
      if (live) this.stop(live.id);
      else this.deps.toast('No dialogue is going on here', 'info');
      return true;
    }
    const start = parseDialogueStart(text, this.deps.myAgents());
    if (start?.kind === 'error') {
      this.deps.toast(start.message, 'warn');
      return true;
    }
    if (start) {
      try {
        this.start({ channel, participants: start.participants, topic: start.topic, mode: start.mode, ...(start.turnCap ? { turnCap: start.turnCap } : {}), ...(start.budget ? { budget: start.budget } : {}) });
      } catch (err) {
        this.deps.toast(err instanceof Error ? err.message : String(err), 'warn');
      }
      return true;
    }
    if (!live || live.status === 'proposed') return false;
    // Commands and messages to an agent go their own way.
    if (!text || text.startsWith('/') || text.startsWith(':') || text.startsWith('@')) return false;
    this.interject(live.id, text);
    return true;
  }

  start(input: DialogueStartInput): Dialogue {
    if (liveDialogueIn(this.deps.store.getState(), input.channel)) throw new DialogueError('A dialogue is already going on here: stop it first');
    const d = this.chair.start({
      channel: input.channel,
      participants: input.participants,
      topic: input.topic,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.turnCap ? { turnCap: input.turnCap } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      startedBy: this.deps.selfName(),
      propose: !input.confirmed,
    });
    // The header card, where the thread begins.
    this.deps.store.dispatch({ type: 'system', id: randomUUID(), channel: input.channel, level: 'info', text: `Dialogue: ${d.topic}`, ts: Date.now(), dialogue: { id: d.id } });
    return d;
  }

  confirm(id: string, caps?: { readonly turnCap?: number; readonly budget?: number | null }): Dialogue {
    return this.chair.confirm(id, caps);
  }

  continue(id: string, more?: number): Dialogue {
    return this.chair.continue(id, more);
  }

  /** Stop (or cancel a proposal): over at once, from the Mac or the phone. */
  stop(id: string): Dialogue {
    return this.chair.stop(id, this.deps.selfName());
  }

  interject(id: string, text: string): Dialogue {
    return this.chair.interject(id, text, this.deps.selfName());
  }

  private changed(d: Dialogue): void {
    const { store } = this.deps;
    const was = store.getState().dialogues[d.id];
    store.dispatch({ type: 'dialogue_put', dialogue: d });
    const channel = d.channel ?? 'room';
    const from = this.posted.get(d.id) ?? 0;
    for (const t of d.turns.slice(from)) {
      const agent = t.by === 'person' ? undefined : d.participants[t.by];
      store.dispatch({
        type: 'chat',
        id: randomUUID(),
        channel,
        // Your agents speak as you (labeled with which agent); a friend's (BLG-468) by their owner.
        from: this.deps.selfId(),
        text: t.text || '(no answer)',
        ts: t.at,
        byAgent: Boolean(agent),
        ...(agent ? { agent: agentFor(d, t.by as number) } : {}),
        dialogue: { id: d.id, turn: t.by === 'person' ? 0 : t.n },
      });
    }
    this.posted.set(d.id, d.turns.length);
    if (isOver(d) && was && !isOver(was)) store.dispatch({ type: 'system', id: randomUUID(), channel, level: d.status === 'failed' ? 'warn' : 'info', text: overLine(d), ts: Date.now() });
  }
}

/** A participant's agent as the chat labels it: two alike get their A/B in the label. */
function agentFor(d: Dialogue, i: number): AgentRef {
  const p = d.participants[i]!;
  const name = speakerName(d, i);
  const own = p.owner ? name.replace(`${p.owner}'s `, '') : name;
  return own === p.agent.label ? p.agent : { ...p.agent, label: own.slice(0, 64) };
}
