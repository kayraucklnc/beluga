import type { AskInput } from '../gateway/gateway.js';
import type { TaskView } from '../gateway/model.js';
import type { DialogueEnvelope } from '../gateway/protocol.js';
import type { DialogueTurnResult, DialogueTurnRun } from './chair.js';
import type { Dialogue, DialogueTurn, Participant } from './model.js';
import { endedBy, speakerName } from './prompt.js';

/**
 * Dialogues across owners (BLG-468). The chair lives with whoever started it; a friend's agent's
 * turn is a gateway task to them (their trust, rules and approvals vet it like any request; store-
 * and-forward and late results already work), carrying a small envelope so their side keeps a copy
 * of the thread. Either side's Stop ends it for both.
 */

/** What the dialogues need of the gateway (core/gateway/gateway.ts). */
export interface DialogueGateway {
  ask(input: AskInput): TaskView;
  wait(id: string, timeoutMs: number): Promise<TaskView>;
  cancel(id: string): TaskView;
  answer(id: string, answers: readonly string[] | 'skip', by: 'agent' | 'person'): TaskView;
  stopDialogue(peerId: string, dialogue: string, why: string): void;
}

/** How long the chair waits for a friend's turn, all told (their Mac may be offline for a while: it goes when they're back). */
export const REMOTE_TURN_MS = 6 * 3600_000;
const WAIT_STEP_MS = 10 * 60_000;
const FINAL = new Set(['done', 'failed', 'declined', 'cancelled']);

/** The turns since this participant last spoke (all of them before its first), for their side's thread. */
function saidSince(d: Dialogue, speaker: number): DialogueEnvelope['said'] {
  let from = 0;
  for (let i = d.turns.length - 1; i >= 0; i--) {
    if (d.turns[i]!.by === speaker) {
      from = i + 1;
      break;
    }
  }
  return d.turns
    .slice(from)
    .slice(-20)
    .map((t) => ({ name: (t.by === 'person' ? (t.name ?? 'Someone') : speakerName(d, t.by)).slice(0, 100), text: t.text.slice(0, 16_000), agent: t.by !== 'person' }));
}

export function envelopeFor(d: Dialogue, turn: number, speaker: number, chair: string): DialogueEnvelope {
  return {
    id: d.id,
    turn,
    cap: d.pauseAt,
    chair: chair.slice(0, 80),
    topic: d.topic.slice(0, 500),
    mode: d.mode,
    participants: d.participants.map((p) => ({ agent: p.agent, ...(p.owner ? { owner: p.owner } : {}) })),
    said: saidSince(d, speaker),
  };
}

/** Why a friend's turn didn't come back with an answer, as the thread says it. */
function notAnswered(p: Participant, task: TaskView): string {
  const who = p.owner ?? 'Their';
  const summary = task.result?.summary?.trim();
  if (task.state === 'declined') return `${who}'s Mac declined it${summary ? `: ${summary}` : ''}`;
  if (task.state === 'cancelled') return summary || 'Cancelled';
  return summary || `${who}'s agent couldn't answer`;
}

/**
 * Run a friend's agent's turn: one gateway task with the turn's brief and prompt, and the
 * envelope. Its questions are skipped (it goes on with its best judgment, as a dialogue has no one
 * to ask mid-turn); Stop cancels it.
 */
export async function remoteTurn(gw: DialogueGateway, run: DialogueTurnRun, chair: string): Promise<DialogueTurnResult> {
  const p = run.participant;
  const d = run.dialogue;
  if (!p.peer) throw new Error('Not a friend’s agent');
  const task = gw.ask({
    person: p.peer,
    ask: `${run.input.dialogue.brief.trim()}\n\n${run.input.prompt}`.slice(0, 16_000),
    summary: `Turn ${run.turn} of a dialogue: ${d.topic}`.slice(0, 140),
    by: 'agent',
    ...(d.channel ? { conversation: d.channel } : {}),
    dialogue: envelopeFor(d, run.turn, run.speaker, chair),
  });
  const signal = run.input.signal;
  const stop = (): void => {
    try {
      gw.cancel(task.id);
    } catch {
      // Gone already.
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const until = Date.now() + REMOTE_TURN_MS;
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const t = await gw.wait(task.id, Math.min(WAIT_STEP_MS, Math.max(0, until - Date.now())));
      if (signal.aborted) throw new Error('aborted');
      if (FINAL.has(t.state)) {
        if (t.state !== 'done') throw new Error(notAnswered(p, t));
        const { text, ended } = endedBy(t.result?.summary ?? '');
        if (ended !== undefined) run.input.dialogue.end(ended);
        return { text, tokens: 0 };
      }
      if (t.question) gw.answer(task.id, 'skip', 'agent');
      else if (Date.now() >= until) {
        stop();
        throw new Error(`${p.owner ?? 'Their'} agent didn't answer in time`);
      }
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/**
 * Your side's copy of a friend's dialogue, from a turn of it that reached you: who talks (your
 * agent named as yours), what was said since your agent last spoke, and, once the task ended,
 * your agent's answer.
 */
export function mirrorFrom(task: TaskView, existing: Dialogue | undefined, selfName: string, channel: string, now: number): Dialogue | undefined {
  const env = task.dialogue;
  if (!env) return existing;
  const self = selfName.toLowerCase();
  const participants: Participant[] = env.participants.map((p) => {
    const owner = p.owner ?? env.chair;
    // Yours: no owner. Theirs: the chair's peer for the chair's agents (others are named only).
    if (owner.toLowerCase() === self) return { agent: p.agent };
    return { agent: p.agent, owner, ...(owner === env.chair ? { peer: task.peerId } : {}) };
  });
  const base: Dialogue = existing ?? {
    id: env.id,
    topic: env.topic,
    mode: env.mode,
    participants,
    turnCap: env.cap,
    pauseAt: env.cap,
    used: 0,
    turns: [],
    status: 'running',
    channel,
    startedBy: env.chair,
    remoteChair: { peer: task.peerId, name: env.chair },
    createdAt: now,
    updatedAt: now,
  };
  if (base.status !== 'running') return base;
  const mine = participants.findIndex((p) => !p.owner);
  let turns: DialogueTurn[] = [...base.turns];
  const seen = (n: number, by: number | 'person', text: string): boolean => turns.some((t) => t.n === n && t.by === by && t.text === text);
  // What was said before this turn (the others' turns and people's words), once each.
  let n = env.turn - env.said.filter((x) => x.agent).length - 1;
  for (const x of env.said) {
    if (x.agent) n++;
    const by = x.agent ? participantNamed(base, x.name) : 'person';
    if (!seen(Math.max(0, n), by, x.text)) turns.push({ n: Math.max(0, n), by, ...(by === 'person' ? { name: x.name } : {}), text: x.text, tokens: 0, at: now });
  }
  // Your agent's answer, once its task ended well.
  if (task.state === 'done' && task.result && mine >= 0 && !seen(env.turn, mine, endedBy(task.result.summary).text)) {
    turns.push({ n: env.turn, by: mine, text: endedBy(task.result.summary).text, tokens: 0, at: now });
  }
  turns = turns.slice(-400);
  return { ...base, turns, pauseAt: Math.max(base.pauseAt, env.cap), updatedAt: now };
}

/** Which participant a name in the envelope is (as speakerName says it on the chair's side). */
function participantNamed(d: Dialogue, name: string): number | 'person' {
  // The chair said names from its side: "Claude", "bob's Codex". Map by agent label and owner.
  const i = d.participants.findIndex((p, idx) => {
    const label = p.agent.label.toLowerCase();
    const n = name.toLowerCase();
    return n === speakerName(d, idx).toLowerCase() || n === label || n.endsWith(`'s ${label}`) || n.startsWith(`${label} `);
  });
  return i >= 0 ? i : 'person';
}
