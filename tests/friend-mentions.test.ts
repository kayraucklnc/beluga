import { describe, expect, it } from 'vitest';
import { buildSystemAppend } from '../src/agent/prompt.js';
import { friendMention, suggest } from '../src/ui/suggest.js';

/** "@mia send me a screenshot of your desktop": friends on the network, tagged by name in a message to your Claude. */

const ctx = { peers: [], selfId: 'me', friends: [{ name: 'mia', online: true }, { name: 'Bob Stone', online: false }] };

describe('@friend in the message box', () => {
  it('offers friends by name, anywhere in the message, saying when they’re offline', () => {
    expect(suggest('@m', ctx)).toEqual([{ label: '@mia', hint: "ask mia's Claude, on their Mac", value: '@mia ', enter: 'complete', kind: 'person' }]);
    expect(suggest('please ask @Bo', ctx)).toEqual([{ label: '@BobStone', hint: "ask Bob Stone's Claude, on their Mac (offline: it goes when they’re back)", value: 'please ask @BobStone ', enter: 'complete', kind: 'person' }]);
    expect(suggest('@mia ', ctx)).toEqual([]);
  });

  it('writes names without spaces or punctuation', () => {
    expect(friendMention('Mia Chen')).toBe('@MiaChen');
    expect(friendMention('o’neil')).toBe('@oneil');
  });

  it('your Claude knows @Name is a friend to ask with ask_person, and to give their notification a summary', () => {
    const prompt = buildSystemAppend('kay');
    expect(prompt).toContain('"@Name" in the user');
    expect(prompt).toContain('Give ask_person a summary');
  });
});

describe('the demo’s Claude reads @friend', () => {
  it('"@bob run the tests" asks bob; "ask mia to …" still works; @claude is not a friend', async () => {
    const { gatewayTarget } = await import('../src/agent/mock.js');
    expect(gatewayTarget('@bob run the tests in bob-api')).toEqual({ person: 'bob', ask: 'run the tests in bob-api' });
    expect(gatewayTarget('hey @mia, send me a screenshot of your desktop!')).toEqual({ person: 'mia', ask: 'send me a screenshot of your desktop' });
    expect(gatewayTarget('ask mia to review the copy')).toEqual({ person: 'mia', ask: 'review the copy' });
    expect(gatewayTarget('@claude fix it')).toBeUndefined();
  });
});
