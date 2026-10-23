import { describe, expect, it } from 'vitest';
import type { LogItem, SubAgent } from '../src/core/store.js';
import type { StepSummary } from '../src/shared/steps.js';
import { READS_AFTER_STEP, STEERED_IN } from '../src/shared/claude-notices.js';
import { inHead, isLiveTurn, withLiveTails, workingPhase } from '../packages/mac/src/chat/live-tail.js';

/** A turn you spoke during goes on below what you said; once it ends it stays where it was drawn (BLG-22). */

type Agent = Extract<LogItem, { type: 'agent' }>;
const chat = (id: string, ts: number): LogItem => ({ id, type: 'chat', channel: 'ws:1', from: 'me', name: 'me', text: id, ts, byAgent: false });
const turn = (id: string, ts: number, more: Partial<Agent> = {}): Agent => ({
  id,
  type: 'agent',
  channel: 'ws:1',
  requestId: id,
  owner: 'me',
  ownerName: 'me',
  requesterName: 'me',
  status: 'tool',
  text: '',
  steps: [],
  subagents: [],
  ts,
  ...more,
});
/** The chat's order: row ids, a split turn's parts marked. */
const order = (rows: readonly LogItem[]) => withLiveTails(rows).map((x) => (x.part ? `${x.row.id}:${x.part.side}` : x.row.id));

describe('withLiveTails', () => {
  it('leaves a turn nobody spoke during whole', () => {
    expect(order([chat('ask', 1), turn('c', 2)])).toEqual(['ask', 'c']);
    expect(order([chat('ask', 1), turn('c', 2, { status: 'done', text: 'ok', endTs: 9 }), chat('next', 10)])).toEqual(['ask', 'c', 'next']);
  });

  it('draws a running turn’s live part below messages sent during it, its head where it began', () => {
    expect(order([chat('ask', 1), turn('c', 2), chat('steer 1', 5), chat('steer 2', 7)])).toEqual(['ask', 'c:head', 'steer 1', 'steer 2', 'c:tail']);
  });

  it('cuts at the first message said during the turn', () => {
    const shown = withLiveTails([chat('ask', 1), turn('c', 2), chat('steer', 5), chat('again', 7)]);
    expect(shown.filter((x) => x.part).map((x) => x.part)).toEqual([
      { side: 'head', cut: 5 },
      { side: 'tail', cut: 5 },
    ]);
    // The two parts are rows of their own (the list keys them apart).
    expect(new Set(shown.map((x) => x.key)).size).toBe(shown.length);
  });

  it('counts notes about steered and queued messages as said during the turn, the live part still last', () => {
    const rows = [chat('ask', 1), turn('c', 2), chat('steer', 5), turn('s', 5, { status: 'text', text: READS_AFTER_STEP }), chat('later', 6), turn('q', 6, { status: 'queued' })];
    expect(order(rows)).toEqual(['ask', 'c:head', 'steer', 's', 'later', 'q', 'c:tail']);
  });

  it('keeps a finished turn where it was drawn: its tail after what was said during it, before what came after', () => {
    const rows = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'answer', endTs: 20 }), chat('steer', 5), turn('s', 5, { status: 'done', text: STEERED_IN }), chat('thanks', 30)];
    expect(order(rows)).toEqual(['ask', 'c:head', 'steer', 's', 'c:tail', 'thanks']);
  });

  it('when the turn ends, its parts don’t move: the same order running and answered', () => {
    const during = [chat('ask', 1), turn('c', 2), chat('steer', 5)];
    const after = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'answer', endTs: 20 }), chat('steer', 5)];
    expect(order(after)).toEqual(order(during));
  });

  it('a queued message’s own turn comes after the finished turn’s tail', () => {
    const rows = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'answer', endTs: 20 }), chat('next', 5), turn('d', 5, { status: 'tool' })];
    expect(order(rows)).toEqual(['ask', 'c:head', 'next', 'c:tail', 'd']);
  });

  it('leaves a finished turn without an end time whole (saved before it was kept)', () => {
    expect(order([turn('c', 2, { status: 'done', text: 'answer' }), chat('later', 5)])).toEqual(['c', 'later']);
  });

  it('two Claudes at work: each live part goes to the end, in order', () => {
    const rows = [turn('mine', 1), chat('hey', 3), turn('bobs', 4, { owner: 'bob' }), chat('more', 5)];
    expect(order(rows)).toEqual(['mine:head', 'hey', 'bobs:head', 'more', 'mine:tail', 'bobs:tail']);
  });
});

describe('isLiveTurn', () => {
  it('is a turn at work, not a queued message or a note about a steered one', () => {
    expect(isLiveTurn(turn('c', 1))).toBe(true);
    expect(isLiveTurn(turn('q', 1, { status: 'queued' }))).toBe(false);
    expect(isLiveTurn(turn('s', 1, { status: 'text', text: READS_AFTER_STEP }))).toBe(false);
    expect(isLiveTurn(turn('d', 1, { status: 'done', text: 'ok' }))).toBe(false);
  });
});

describe('inHead', () => {
  const step = (id: string, startedAt: number, more: Partial<StepSummary> = {}): StepSummary => ({ id, kind: 'tool', title: id, status: 'done', startedAt, ...more });

  it('keeps only steps that had finished before the cut', () => {
    expect(inHead(step('a', 1, { endedAt: 3 }), 5)).toBe(true);
    expect(inHead(step('b', 1, { durationMs: 2 }), 5)).toBe(true);
    expect(inHead(step('c', 4, { endedAt: 8 }), 5)).toBe(false);
    expect(inHead(step('d', 6, { endedAt: 7 }), 5)).toBe(false);
  });

  it('never the step Claude is on, or one-line steps without times', () => {
    expect(inHead(step('run', 1, { status: 'running' }), 5)).toBe(false);
    expect(inHead(step('line-0', 1), 5)).toBe(false);
  });
});

describe('workingPhase', () => {
  const sub = (title: string, status: SubAgent['status'], kind: SubAgent['kind'] = 'agent'): SubAgent => ({ id: title, title, steps: [], status, kind });

  it('says what Claude is doing', () => {
    expect(workingPhase(turn('c', 1))).toBe('Starting');
    expect(workingPhase(turn('c', 1, { between: 'thinking', steps: ['Read src/a.ts'] }))).toBe('Thinking');
    // A step running says itself, in its row just above.
    expect(workingPhase(turn('c', 1, { steps: ['Bash npm test'] }))).toBe('');
    expect(workingPhase(turn('c', 1, { status: 'text', text: 'So far', between: 'writing' }))).toBe('Writing');
    expect(workingPhase(turn('c', 1, { status: 'text', text: 'Answered', subagents: [sub('npm run build', 'running', 'background')] }))).toBe('Waiting on 1 background task · npm run build');
  });

  it('nothing when it isn’t at work, or waits for an approval', () => {
    expect(workingPhase(turn('c', 1, { status: 'done', text: 'ok' }))).toBeUndefined();
    expect(workingPhase(turn('c', 1, { status: 'awaiting_approval' }))).toBeUndefined();
    expect(workingPhase(turn('q', 1, { status: 'queued' }))).toBeUndefined();
  });
});
