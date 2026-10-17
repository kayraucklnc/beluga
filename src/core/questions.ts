import { randomUUID } from 'node:crypto';
import type { BodyInput, BodyOf, ClaudeAnswer, ClaudeQuestion } from '../protocol.js';
import { type Store, clean } from './store.js';

export interface QuestionDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  /** How long Claude waits for an answer before carrying on without one. */
  readonly timeoutMs: () => number;
  readonly toast: (text: string, level?: 'info' | 'warn') => void;
}

const SKIP: ClaudeAnswer = { kind: 'skip' };

/** Peer-supplied text never carries terminal control sequences onto your screen. */
export function cleanQuestion(q: ClaudeQuestion): ClaudeQuestion {
  if (q.kind === 'plan') return { kind: 'plan', plan: clean(q.plan) };
  return {
    kind: 'question',
    questions: q.questions.map((x) => ({ ...x, question: clean(x.question), header: clean(x.header), options: x.options.map((o) => ({ label: clean(o.label), description: clean(o.description) })) })),
  };
}

const MAX_WAITING = 20;

/**
 * Claude's questions and plans go to the person who asked Claude, wherever they are:
 * a card on your own screen, or a message to a friend whose request it is. Answers
 * are only accepted from that person, and nobody waits forever.
 */
export class QuestionBroker {
  private readonly waiting = new Map<string, { peer: string; resolve: (a: ClaudeAnswer) => void; timer: NodeJS.Timeout }>();
  /** Requests you sent → whose Claude got them, so only that Claude can ask you things. */
  private readonly mine = new Map<string, { target: string; channel: string }>();

  constructor(private readonly deps: QuestionDeps) {}

  /** Remember a request you sent (to your own or a friend's Claude). */
  track(requestId: string, target: string, channel: string): void {
    this.mine.set(requestId, { target, channel });
    if (this.mine.size > 500) this.mine.delete(this.mine.keys().next().value as string);
  }

  /** On the computer running Claude: ask `requester` and wait for their answer. */
  ask(requester: string, requestId: string, channel: string, question: ClaudeQuestion): Promise<ClaudeAnswer> {
    if (this.waiting.size >= MAX_WAITING) return Promise.resolve(SKIP);
    const qid = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(qid)) return;
        this.deps.store.dispatch({ type: 'question_remove', qid });
        this.deps.toast(`Claude's ${question.kind === 'plan' ? 'plan' : 'question'} went unanswered, so it carried on without it`, 'warn');
        resolve(SKIP);
      }, this.deps.timeoutMs());
      timer.unref();
      this.waiting.set(qid, { peer: requester, resolve, timer });
      if (requester === this.deps.selfId()) {
        this.deps.store.dispatch({ type: 'question_add', question: { qid, requestId, owner: requester, channel, question, picked: {} } });
      } else if (!this.deps.send({ kind: 'agent_question', requestId, qid, channel, question }, { to: requester })) {
        this.settle(qid, requester, SKIP);
      }
    });
  }

  /** A friend's Claude, working on your request, asks you something. */
  onQuestion(from: string, body: BodyOf<'agent_question'>): void {
    const sent = this.mine.get(body.requestId);
    if (!sent || sent.target !== from || sent.channel !== body.channel) return;
    this.deps.store.dispatch({ type: 'question_add', question: { qid: body.qid, requestId: body.requestId, owner: from, channel: body.channel, question: cleanQuestion(body.question), picked: {} } });
  }

  /** Someone left: stop waiting on questions only they could answer. */
  cancelFor(peerId: string): void {
    for (const [qid, w] of [...this.waiting]) if (w.peer === peerId) this.settle(qid, peerId, SKIP);
  }

  /** The person you asked answered. */
  onAnswer(from: string, body: BodyOf<'agent_answer'>): void {
    this.settle(body.qid, from, body.answer);
  }

  /** You answered a card on your screen. */
  answer(qid: string, answer: ClaudeAnswer): void {
    const q = this.deps.store.getState().questions.find((x) => x.qid === qid);
    if (!q) return;
    this.deps.store.dispatch({ type: 'question_remove', qid });
    const self = this.deps.selfId();
    if (q.owner === self) this.settle(qid, self, answer);
    else this.deps.send({ kind: 'agent_answer', qid, answer }, { to: q.owner });
  }

  /** Stop waiting on everything (e.g. Claude was stopped). */
  cancelAll(): void {
    for (const [qid, w] of [...this.waiting]) this.settle(qid, w.peer, SKIP);
  }

  private settle(qid: string, from: string, answer: ClaudeAnswer): void {
    const w = this.waiting.get(qid);
    if (!w || w.peer !== from) return;
    clearTimeout(w.timer);
    this.waiting.delete(qid);
    this.deps.store.dispatch({ type: 'question_remove', qid });
    w.resolve(answer);
  }
}
