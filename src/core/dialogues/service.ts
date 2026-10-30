import { randomUUID } from 'node:crypto';
import type { AgentRef } from '../../protocol.js';
import type { Store } from '../store.js';
import { Chair, type DialogueTurnResult, type DialogueTurnRun } from './chair.js';
import { type Dialogue, DialogueError, type DialogueMode, type Participant, isOver, liveDialogueIn } from './model.js';
import type { GatewayDialogues } from '../gateway/gateway.js';
import type { TaskView } from '../gateway/model.js';
import { speakerName } from './prompt.js';
import { type DialogueGateway, mirrorFrom, remoteTurn } from './remote.js';
import { type FriendAgent, parseDialogueStart } from './start.js';

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
  /** The worktree a conversation is (its folder), for work mode; undefined anywhere else. */
  readonly worktreeOf?: (channel: string) => string | undefined;
  /** Friends' agents (BLG-468): who `@bob:codex` is, and the gateway their turns go through. */
  readonly friendAgent?: FriendAgent;
  readonly gateway?: () => DialogueGateway | undefined;
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
  /** Friends' dialogues you're in (they chair them): your side's copy of each thread. */
  private readonly mirrors = new Map<string, Dialogue>();
  /** Dialogues the other side stopped: not told back to them. */
  private readonly quiet = new Set<string>();

  constructor(private readonly deps: DialoguesDeps) {
    this.chair = new Chair({ ...(deps.dir ? { dir: deps.dir } : {}), runTurn: (run) => this.runTurn(run), onChange: (d) => this.changed(d) });
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
    const start = parseDialogueStart(text, this.deps.myAgents(), this.deps.friendAgent);
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
    // A friend's dialogue: what you type goes on as usual (its chair is on their side).
    if (!live || live.status === 'proposed' || live.remoteChair) return false;
    // Commands and messages to an agent go their own way.
    if (!text || text.startsWith('/') || text.startsWith(':') || text.startsWith('@')) return false;
    this.interject(live.id, text);
    return true;
  }

  start(input: DialogueStartInput): Dialogue {
    if (liveDialogueIn(this.deps.store.getState(), input.channel)) throw new DialogueError('A dialogue is already going on here: stop it first');
    // Work happens in exactly one worktree: this conversation's.
    const worktree = input.mode === 'work' ? this.deps.worktreeOf?.(input.channel) : undefined;
    const d = this.chair.start({
      channel: input.channel,
      participants: input.participants,
      topic: input.topic,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.turnCap ? { turnCap: input.turnCap } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      startedBy: this.deps.selfName(),
      ...(worktree ? { worktree } : {}),
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

  /** Stop (or cancel a proposal): over at once, from the Mac or the phone; a friend's dialogue ends for both. */
  stop(id: string): Dialogue {
    const mirror = this.mirrors.get(id);
    if (mirror) return this.putMirror({ ...mirror, status: isOver(mirror) ? mirror.status : 'stopped', note: isOver(mirror) ? mirror.note : `Stopped by ${this.deps.selfName()}`, updatedAt: Date.now() });
    return this.chair.stop(id, this.deps.selfName());
  }

  /** What the gateway tells dialogues (core/gateway GatewayDialogues): friends' turns and stops. */
  gatewayPort(): GatewayDialogues {
    return {
      turn: (task) => this.friendTurn(task),
      stopped: (from, fromName, id, why) => this.stoppedThere(from, fromName, id, why),
      isStopped: (id) => {
        const m = this.mirrors.get(id);
        return m ? isOver(m) : false;
      },
    };
  }

  /** A turn of yours in a friend's dialogue came in or ended: your copy of their thread follows. */
  private friendTurn(task: TaskView): void {
    if (task.direction !== 'received' || !task.dialogue) return;
    const prev = this.mirrors.get(task.dialogue.id);
    const channel = prev?.channel ?? task.chat ?? 'room';
    const next = mirrorFrom(task, prev, this.deps.selfName(), channel, Date.now());
    if (!next || next === prev) return;
    if (!prev) this.deps.store.dispatch({ type: 'system', id: randomUUID(), channel, level: 'info', text: `Dialogue: ${next.topic}`, ts: Date.now(), dialogue: { id: next.id } });
    this.putMirror(next);
  }

  /** The other side stopped (or ended) a dialogue: it ends here too, without telling them back. */
  private stoppedThere(from: string, fromName: string, id: string, why: string): void {
    const mirror = this.mirrors.get(id);
    if (mirror && mirror.remoteChair?.peer === from && !isOver(mirror)) {
      this.quiet.add(id);
      this.putMirror({ ...mirror, status: 'stopped', note: why || `Stopped by ${fromName}`, updatedAt: Date.now() });
      return;
    }
    const d = this.chair.get(id);
    if (d && !isOver(d) && d.participants.some((p) => p.peer === from)) {
      this.quiet.add(id);
      this.chair.stop(id, fromName);
    }
  }

  private putMirror(d: Dialogue): Dialogue {
    this.mirrors.set(d.id, d);
    this.changed(d);
    return d;
  }

  /** A turn: your agent's runs here, a friend's goes to them through the gateway. */
  private runTurn(run: DialogueTurnRun): Promise<DialogueTurnResult> {
    if (!run.participant.peer) return this.deps.runTurn(run);
    const gw = this.deps.gateway?.();
    if (!gw) return Promise.reject(new Error('Friends’ agents need the Beluga app’s network'));
    return remoteTurn(gw, run, this.deps.selfName());
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
        // Your agents speak as you (labeled with which agent); a friend's (BLG-468) as them; people's words as whoever chairs.
        from: agent?.peer ?? (t.by === 'person' && d.remoteChair && t.name !== this.deps.selfName() ? d.remoteChair.peer : this.deps.selfId()),
        text: t.text || '(no answer)',
        ts: t.at,
        byAgent: Boolean(agent),
        ...(agent ? { agent: agentFor(d, t.by as number) } : {}),
        dialogue: { id: d.id, turn: t.by === 'person' ? 0 : t.n },
      });
    }
    this.posted.set(d.id, d.turns.length);
    if (isOver(d) && was && !isOver(was)) {
      store.dispatch({ type: 'system', id: randomUUID(), channel, level: d.status === 'failed' ? 'warn' : 'info', text: overLine(d), ts: Date.now() });
      // Over here: over for the friends in it too (unless they ended it).
      if (!this.quiet.delete(d.id)) {
        const peers = d.remoteChair ? [d.remoteChair.peer] : [...new Set(d.participants.flatMap((x) => (x.peer ? [x.peer] : [])))];
        const gw = peers.length ? this.deps.gateway?.() : undefined;
        for (const peer of peers) gw?.stopDialogue(peer, d.id, d.note ?? overLine(d));
      }
    }
  }
}

/** A participant's agent as the chat labels it: two alike get their A/B in the label. */
function agentFor(d: Dialogue, i: number): AgentRef {
  const p = d.participants[i]!;
  const name = speakerName(d, i);
  const own = p.owner ? name.replace(`${p.owner}'s `, '') : name;
  return own === p.agent.label ? p.agent : { ...p.agent, label: own.slice(0, 64) };
}
