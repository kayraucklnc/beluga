import { describe, expect, it } from 'vitest';
import { parseAttachmentHref, splitImages } from '../src/shared/attachment-links.js';
import { type LogItem, Store, initialState, orderQueued } from '../src/core/store.js';
import { queueIn } from '../src/ui/compose.js';

const link = (n: number, owner = 'kay', file = `shot-${n}.png`): string => `[📎 image ${n} (png, 120K)](klaud-attachment:${owner}/${file})`;

describe('images in a message', () => {
  it('reads an image link target', () => {
    expect(parseAttachmentHref('klaud-attachment:kay/shot.png')).toEqual({ owner: 'kay', file: 'shot.png' });
    expect(parseAttachmentHref('klaud-attachment:kay/a/b.png')).toBeUndefined();
    expect(parseAttachmentHref('klaud-attachment:/b.png')).toBeUndefined();
    expect(parseAttachmentHref('https://x.dev/a.png')).toBeUndefined();
  });

  it('shows images below the words, dropping links that open or close the message', () => {
    const out = splitImages(`${link(1)} what is wrong here?`);
    expect(out.text).toBe('what is wrong here?');
    expect(out.images).toEqual([{ href: 'klaud-attachment:kay/shot-1.png', owner: 'kay', file: 'shot-1.png', label: 'image 1', detail: 'png, 120K' }]);
    expect(splitImages(`compare ${link(1)} ${link(2)}`).text).toBe('compare');
    expect(splitImages(`${link(1)}\n${link(2)}`)).toMatchObject({ text: '', images: [{ label: 'image 1' }, { label: 'image 2' }] });
  });

  it('keeps a short link where an image sits mid-sentence', () => {
    const out = splitImages(`is ${link(1)} better than ${link(2)} here?`);
    expect(out.text).toBe('is [image 1](klaud-attachment:kay/shot-1.png) better than [image 2](klaud-attachment:kay/shot-2.png) here?');
    expect(out.images.map((i) => i.label)).toEqual(['image 1', 'image 2']);
  });

  it('lists each image once and leaves other text alone', () => {
    expect(splitImages(`${link(1)} and again ${link(1)}`).images).toHaveLength(1);
    expect(splitImages('no images [here](https://x.dev)')).toEqual({ text: 'no images [here](https://x.dev)', images: [] });
    expect(splitImages('[sneaky](klaud-attachment:kay/../etc/passwd)').images).toEqual([]);
  });
});

const agent = (requestId: string, owner: string, extra: Partial<Extract<LogItem, { type: 'agent' }>> = {}): LogItem => ({
  id: requestId,
  type: 'agent',
  channel: 'room',
  subagents: [],
  requestId,
  owner,
  ownerName: owner,
  requesterName: owner,
  requester: owner,
  status: 'queued',
  text: '',
  steps: [],
  ts: 1,
  ...extra,
});
const chat = (id: string): LogItem => ({ id, type: 'chat', channel: 'room', from: 'kay', name: 'kay', text: id, ts: 1, byAgent: false });

describe('the queue', () => {
  it('reorders waiting requests in the places they take', () => {
    const log = [agent('a', 'kay'), chat('hi'), agent('b', 'kay'), agent('x', 'bob'), agent('c', 'kay')];
    const out = orderQueued(log, 'kay', ['c', 'a', 'b']);
    expect(out.map((l) => l.id)).toEqual(['c', 'hi', 'a', 'x', 'b']);
    // Same order, or a request that isn't there: nothing changes.
    expect(orderQueued(log, 'kay', ['a', 'b', 'c'])).toBe(log);
    expect(orderQueued(log, 'kay', ['a', 'zzz'])).toBe(log);
  });

  it('keeps the prompt sent with "queued" and who asked', () => {
    const store = new Store(initialState('r'));
    store.dispatch({ type: 'agent_event', owner: 'kay', requestId: 'r1', requester: 'bob', event: 'queued', text: 'add tests', ts: 1 });
    store.dispatch({ type: 'agent_event', owner: 'kay', requestId: 'r1', requester: 'bob', event: 'started', text: '', ts: 2 });
    expect(store.getState().log[0]).toMatchObject({ prompt: 'add tests', requester: 'bob', status: 'started', text: '' });
    store.dispatch({ type: 'queue_order', owner: 'kay', ids: ['r1'] });
    expect(store.getState().log).toHaveLength(1);
  });

  it("lists what waits for your Claude and what you asked of others', in order", () => {
    const log = [
      agent('a', 'me', { prompt: 'first' }),
      agent('b', 'me', { requester: 'bob', requesterName: 'bob', prompt: 'for bob' }),
      agent('c', 'bob', { requester: 'me', requesterName: 'me', ownerName: 'bob', prompt: 'ask bob' }),
      agent('d', 'bob', { requester: 'zoe', requesterName: 'zoe' }),
      agent('e', 'me', { status: 'started' }),
      agent('f', 'me', { channel: 'ws:w1' }),
    ];
    expect(queueIn({ log }, 'room', 'me')).toEqual([
      { requestId: 'a', prompt: 'first', by: 'me', claude: 'me', yours: true },
      { requestId: 'b', prompt: 'for bob', by: 'bob', claude: 'me', yours: false },
      { requestId: 'c', prompt: 'ask bob', by: 'me', claude: 'bob', yours: false },
    ]);
    // Saved before the requester was kept: decided by name, as before.
    const { requester: _r, ...old } = agent('g', 'me') as Extract<LogItem, { type: 'agent' }>;
    expect(queueIn({ log: [old] }, 'room', 'me')[0]).toMatchObject({ yours: true, prompt: '' });
  });
});
