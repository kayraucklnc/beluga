import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AnswerRequests } from '../../src/core/chat/requests.js';
import type { AskInput } from '../../src/core/gateway/gateway.js';
import type { TaskView } from '../../src/core/gateway/model.js';
import type { MessageView } from '../../src/net/mesh/views.js';

const ME = 'me'.padEnd(32, '0');
const BERCA = 'berca'.padEnd(32, '0');
const MIA = 'mia'.padEnd(32, '0');
const CONV = 'group:'.padEnd(38, 'a');
const NOW = 1_800_000_000_000;

/** A mesh with one conversation: what's in it, and new messages as they come. */
function rig(log: MessageView[]) {
  const mesh = Object.assign(new EventEmitter(), { peerId: ME, conversation: () => log });
  const sent: AskInput[] = [];
  const problems: string[] = [];
  let fail: string | undefined;
  const requests = new AnswerRequests({
    mesh: mesh as never,
    ask: (input) => {
      if (fail) throw new Error(fail);
      sent.push(input);
      return { id: 't_abcdefghijk' } as TaskView;
    },
    onProblem: (_c, name, text) => problems.push(`${name}: ${text}`),
    now: () => NOW,
  });
  const arrive = (m: MessageView): void => {
    log.push(m);
    mesh.emit('message', m);
  };
  return { sent, problems, arrive, requests, failWith: (why: string) => (fail = why) };
}

const msg = (id: string, from: string, extra: Partial<MessageView> = {}): MessageView => ({ id, conversation: CONV, from, name: from === ME ? 'you' : from.replace(/0+$/, ''), text: 'hi', ts: NOW - 1000, mine: from === ME, ...extra }) as MessageView;
const answer = (id: string, from: string, forId: string, extra: Partial<MessageView> = {}): MessageView => msg(id, from, { text: 'Sending it to my Mac as a request.', claude: { for: forId, request: { ask: 'Open https://example.com in the browser', needs: ['device'] } }, ...extra });

describe('a friend’s Claude answering your ask with something for their Mac (BLG-353)', () => {
  it('goes there as your request at once, from the chat it was asked in, once', () => {
    const ask = msg('m1', ME, { text: '@claude:berca open this link', ask: { to: [BERCA] } });
    const r = rig([ask]);
    const a = answer('m2', BERCA, 'm1');
    r.arrive(a);
    r.arrive(a); // a resync brings it again
    expect(r.sent).toEqual([{ person: BERCA, ask: 'Open https://example.com in the browser', by: 'person', conversation: CONV, answer: 'm2', needs: ['device'] }]);
  });

  it('never for someone else’s ask, an answer without a request, a Claude you didn’t call in, or an old answer', () => {
    const mine = msg('m1', ME, { ask: { to: [BERCA] } });
    const theirs = msg('m2', MIA, { ask: { to: [BERCA] } });
    const r = rig([mine, theirs]);
    r.arrive(answer('a1', BERCA, 'm2'));
    r.arrive(msg('a2', BERCA, { claude: { for: 'm1' } }));
    r.arrive(answer('a3', MIA, 'm1'));
    r.arrive(answer('a4', BERCA, 'm1', { ts: NOW - 11 * 60_000 }));
    expect(r.sent).toEqual([]);
  });

  it('one that can’t go says why (and keeps its button)', () => {
    const r = rig([msg('m1', ME, { ask: { to: 'all' } })]);
    r.failWith('berca’s Beluga doesn’t take requests');
    r.arrive(answer('a1', BERCA, 'm1'));
    expect(r.problems).toEqual(['berca: berca’s Beluga doesn’t take requests']);
  });
});
