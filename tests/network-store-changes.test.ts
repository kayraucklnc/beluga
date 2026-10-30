import { describe, expect, it } from 'vitest';
import { initialNetwork, reduceNetwork } from '../src/core/network-store.js';
import type { MessageView } from '../src/net/mesh/views.js';

const msg = (id: string, text = id): MessageView => ({ id, conversation: 'dm:x', from: 'a', name: 'A', text, ts: 1, mine: false });

describe('network store: deleted and cleared messages (BLG-425)', () => {
  it('drops a deleted message, replaces an edited one, and empties a cleared chat', () => {
    let st = reduceNetwork(initialNetwork, { type: 'net_messages', messages: { 'dm:x': [msg('m1'), msg('m2')] } });
    st = reduceNetwork(st, { type: 'net_message', message: { ...msg('m2', 'fixed'), edited: 5 } });
    expect(st.network.messages['dm:x']?.map((m) => m.text)).toEqual(['m1', 'fixed']);
    st = reduceNetwork(st, { type: 'net_unsent', conversation: 'dm:x', id: 'm1' });
    expect(st.network.messages['dm:x']?.map((m) => m.id)).toEqual(['m2']);
    expect(reduceNetwork(st, { type: 'net_unsent', conversation: 'dm:x', id: 'nope' })).toBe(st);
    st = reduceNetwork(st, { type: 'net_cleared', conversation: 'dm:x' });
    expect(st.network.messages['dm:x']).toEqual([]);
  });
});
